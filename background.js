// 常に名前を付けて保存 - background.js
//
// 仕組み:
// 1. 通常どおりダウンロードが開始される (onCreated が発火)
// 2. すぐにキャンセルし、履歴からも消す
// 3. 同じURLに対して chrome.downloads.download({ saveAs: true }) を
//    呼び出し、OSの「名前を付けて保存」ダイアログを強制的に開かせる
//
// EXPECTED は「自分自身が再発行したダウンロードのID」を記録しておき、
// そのダウンロードが onCreated で再度検知された際に
// 無限ループ(キャンセル→再ダウンロード→キャンセル…)にならないようにするためのもの。

// 【重大バグ修正】以前はURLをキーにした「件数カウンタ」で追跡していたが、
// 同じURLを短時間に2件ダウンロードした場合、片方の再ダウンロードが
// もう片方の「自分の再ダウンロードだ」という判定を誤って横取りしてしまい、
// 逆にもう片方が二重に横取りされる、という競合状態がテストで発覚した
// (ファイル名確定を待つ await を追加した影響で、この競合が起きる隙間が
//  広がり顕在化した)。
// ダウンロードIDはブラウザが発行する一意な値なので、URLではなく
// 「再発行した“その”ダウンロードのID」そのものをキーにすることで、
// 同じURLの同時ダウンロード同士が互いに干渉しないようにする。
const EXPECTED_IDS_KEY = "expectedDownloadIds";

async function isExpectedId(id) {
  const { [EXPECTED_IDS_KEY]: ids } = await chrome.storage.session.get(EXPECTED_IDS_KEY);
  return !!(ids && ids[id]);
}

async function markExpectedId(id) {
  const { [EXPECTED_IDS_KEY]: ids } = await chrome.storage.session.get(EXPECTED_IDS_KEY);
  const map = ids || {};
  map[id] = true;
  await chrome.storage.session.set({ [EXPECTED_IDS_KEY]: map });
}

async function unmarkExpectedId(id) {
  const { [EXPECTED_IDS_KEY]: ids } = await chrome.storage.session.get(EXPECTED_IDS_KEY);
  const map = ids || {};
  delete map[id];
  await chrome.storage.session.set({ [EXPECTED_IDS_KEY]: map });
}

// 【バグ修正】報告されたバグ: 保存ダイアログに表示される名前が、
// サイトが本来意図していたファイル名と異なってしまう。
//
// 原因: サイトによっては <a download="請求書.pdf" href="..."> のように、
// HTML側の download 属性で保存時のファイル名を指定している。この情報は
// URLそのものには含まれておらず、ページのDOM/JavaScript側にしかない。
// 従来はURLだけを使って再ダウンロードを発行していたため、この
// download属性由来の名前が失われ、Chromeが自動生成した別名
// (URL末尾等)が保存ダイアログに表示されてしまっていた。
//
// 対策: chrome.downloads.onDeterminingFilename は、ブラウザが
// (download属性やContent-Dispositionヘッダーを考慮したうえで)
// 本来使うはずだったファイル名を教えてくれるイベント。
// これを使って正しい名前を先に取得し、再ダウンロード時に明示的に
// 指定することで、保存ダイアログに正しい名前が表示されるようにする。
function waitForDeterminedFilename(downloadId, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId;

    const listener = (item, suggest) => {
      if (item.id !== downloadId) {
        // 自分が対象とするダウンロード以外には関与せず、
        // ブラウザの既定の判断に任せる。
        suggest();
        return;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId); // 【バグ修正】早期解決時にタイマーを止め忘れると、
        // service worker が最大timeoutMs分、無駄に生き続けてしまう。
        resolve(item.filename || "");
      }
      // 元のダウンロード自体の名前は変更しない(このあと即キャンセルするため
      // 実際に書き込まれることはない)。あくまで名前を「知る」ためだけに使う。
      suggest();
      chrome.downloads.onDeterminingFilename.removeListener(listener);
    };

    chrome.downloads.onDeterminingFilename.addListener(listener);

    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.downloads.onDeterminingFilename.removeListener(listener);
        resolve(""); // タイムアウト時は諦め、従来どおりChrome任せにする
      }
    }, timeoutMs);
  });
}

// 【重大バグ修正】報告されたバグ: ブラウザのウィンドウをすべて閉じても、
// Edgeの「終了してもバックグラウンドで拡張機能の実行を続行する」設定
// (既定でオン)により、この拡張機能のservice workerは動き続ける。
// その状態でダウンロードが発生すると、saveAs:true でダイアログを
// 表示しようとしても、表示先となるウィンドウが存在しない。
// この場合、ダイアログを出せないままファイルが仮の名前で自動保存され、
// それを拡張機能が「新しい元のダウンロード」だと誤認識して
// 再度横取り→また自動保存…を繰り返す無限ループとなり、
// ダウンロードフォルダに大量の一時ファイルが生成される不具合が発生していた。
//
// 対策として、開いているウィンドウが1つも無い場合は横取りを行わず、
// ダウンロードを素通りさせる。
async function hasOpenWindow() {
  const windows = await chrome.windows.getAll();
  return windows.length > 0;
}

// 【安全装置】上記の対策に加え、原因が完全には特定できない場合に備えた
// 多重防御として、同じURLへの横取りが短時間に繰り返された場合は
// 自動的に横取りをあきらめ、通常のダウンロードとして素通りさせる。
// これにより、万一何らかの理由で無限ループの経路が別に存在しても、
// 一時ファイルが「延々と」作られ続ける事態を防ぐ。
const ATTEMPTS_KEY = "interceptAttempts";
const MAX_INTERCEPT_ATTEMPTS = 3;
const ATTEMPT_WINDOW_MS = 15000;

async function shouldGiveUp(url) {
  const { [ATTEMPTS_KEY]: attempts } = await chrome.storage.session.get(ATTEMPTS_KEY);
  const map = attempts || {};
  const now = Date.now();
  const record = map[url];

  if (record && now - record.firstAttemptAt < ATTEMPT_WINDOW_MS) {
    if (record.count >= MAX_INTERCEPT_ATTEMPTS) {
      return true; // 上限超過 → あきらめる
    }
    record.count += 1;
  } else {
    map[url] = { count: 1, firstAttemptAt: now };
  }
  await chrome.storage.session.set({ [ATTEMPTS_KEY]: map });
  return false;
}

// 【重大バグ修正】報告されたバグ: ブラウザを終了して再起動すると、
// 過去にダウンロードした(≒終了時点で完了していなかった)ファイルが
// 再びダウンロードされ、それが .temp ファイル大量発生の原因になっていた。
//
// Chromiumはブラウザ終了時に進行中だったダウンロードの記録を保持しており、
// 再起動時にそれらが動き出す(またはそう見える)ことがあると考えられる。
// この拡張機能の外側で起きている厳密な内部動作までは特定しきれないため、
// 「原因を問わず、明らかに“今まさにユーザーが操作した新規ダウンロード”とは
// 考えにくいものは横取りしない」という2段構えの防御策を入れる。

// 対策A: ダウンロードの開始時刻が「今」から大きく離れている場合、
// たった今ユーザーが開始した操作とは考えにくいため横取りしない。
const FRESHNESS_THRESHOLD_MS = 10000; // 10秒

function isSuspiciouslyOld(item) {
  if (!item || !item.startTime) return false;
  const started = new Date(item.startTime).getTime();
  if (Number.isNaN(started)) return false;
  return Date.now() - started > FRESHNESS_THRESHOLD_MS;
}

// 対策B: ブラウザ起動直後は、セッション復元やダウンロード履歴の再評価が
// 集中しやすいタイミングなので、しばらくの間は横取りを見合わせる。
const STARTUP_AT_KEY = "startupAt";
const STARTUP_GRACE_MS = 5000; // 5秒

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.session.set({ [STARTUP_AT_KEY]: Date.now() });
});

async function isInStartupGracePeriod() {
  const { [STARTUP_AT_KEY]: startupAt } = await chrome.storage.session.get(STARTUP_AT_KEY);
  if (!startupAt) return false;
  return Date.now() - startupAt < STARTUP_GRACE_MS;
}

// 【重大バグ修正】ユーザーが「名前を付けて保存」ダイアログでキャンセルを選んだ場合、
// そのダウンロードは interrupted(中断)状態のままダウンロード履歴に残ってしまう。
// このエントリが後になんらかの形で再度検知される(例: 別の処理のきっかけになる、
// 履歴一覧に残り続けて紛らわしい等)ことが、繰り返しダウンロードが始まる原因の
// 一つになっていた。
// そこで、自分がsaveAs付きで再発行したダウンロードのIDを記録しておき、
// それが中断状態になったら即座に履歴から消去する。
const OWNED_IDS_KEY = "ownedDownloadIds";

async function markOwned(id) {
  const { [OWNED_IDS_KEY]: ids } = await chrome.storage.session.get(OWNED_IDS_KEY);
  const map = ids || {};
  map[id] = true;
  await chrome.storage.session.set({ [OWNED_IDS_KEY]: map });
}

async function unmarkOwned(id) {
  const { [OWNED_IDS_KEY]: ids } = await chrome.storage.session.get(OWNED_IDS_KEY);
  const map = ids || {};
  delete map[id];
  await chrome.storage.session.set({ [OWNED_IDS_KEY]: map });
}

async function isOwned(id) {
  const { [OWNED_IDS_KEY]: ids } = await chrome.storage.session.get(OWNED_IDS_KEY);
  return !!(ids && ids[id]);
}

// 【バグ修正】同じURLのダウンロードがほぼ同時に発生すると、
// onCreated ハンドラ(非同期)が並行に実行され、
// getPending()→setPending() の間に別の呼び出しが割り込んで
// カウントの更新を上書きしてしまう競合状態が起きていた
// (テストで実際に、余計なcancel/downloadが1回多く発生することを確認済み)。
// 単純なPromiseチェーンによるロックで、onCreatedの処理を直列化して防ぐ。
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {}); // エラーが起きてもチェーンは途切れさせない
  return run;
}

async function isEnabled() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  return enabled;
}

async function updateBadge(enabled) {
  const text = enabled
    ? chrome.i18n.getMessage("badgeOn")
    : chrome.i18n.getMessage("badgeOff");
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({
    color: enabled ? "#1a73e8" : "#9e9e9e",
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const enabled = await isEnabled();
  await updateBadge(enabled);
});

// ツールバーのアイコンクリックでON/OFFを切り替える
chrome.action.onClicked.addListener(async () => {
  const current = await isEnabled();
  const next = !current;
  await chrome.storage.local.set({ enabled: next });
  await updateBadge(next);
});

chrome.downloads.onCreated.addListener((item) => withLock(async () => {
  const enabled = await isEnabled();
  if (!enabled) return;

  const url = item.url;

  // このダウンロードは自分自身が saveAs:true 付きで再発行したものなので、
  // そのまま通過させる(ここでキャンセルすると無限ループになる)。
  // (IDそのもので判定するため、同じURLの別の同時ダウンロードと混同しない)
  if (await isExpectedId(item.id)) {
    await unmarkExpectedId(item.id);
    return;
  }

  // 開始時刻が現在からかけ離れている場合、たった今の新規操作ではない
  // 可能性が高いため横取りしない(再起動時の誤検知対策・対策A)。
  if (isSuspiciouslyOld(item)) {
    console.warn(
      "開始時刻が現在時刻から離れているため横取りしません(再起動時の再検知対策):",
      url,
      item.startTime
    );
    return;
  }

  // ブラウザ起動直後の猶予期間中は横取りしない(再起動時の誤検知対策・対策B)。
  if (await isInStartupGracePeriod()) {
    console.warn(
      "ブラウザ起動直後のため、しばらく横取りを見合わせます(再起動直後の誤検知対策):",
      url
    );
    return;
  }

  // 表示できるウィンドウが無ければ、saveAsダイアログを出しようがないため
  // 横取りせずに素通りさせる(無限ループ・大量一時ファイル発生の直接対策)。
  if (!(await hasOpenWindow())) {
    console.warn(
      "開いているウィンドウが無いため、このダウンロードは横取りしません(バックグラウンド実行中):",
      url
    );
    return;
  }

  // 同じURLへの横取りが短時間に繰り返されすぎていないか確認する(安全装置)。
  if (await shouldGiveUp(url)) {
    console.warn(
      `同じURLへの横取りが${MAX_INTERCEPT_ATTEMPTS}回を超えたため、これ以上は横取りしません:`,
      url
    );
    return;
  }

  // 元のダウンロードをキャンセルする"前"に、Chromeが本来決定するはずだった
  // ファイル名(download属性やContent-Dispositionヘッダーを反映したもの)を
  // 取得しておく。ここを飛ばしてキャンセルしてしまうと、再ダウンロード時に
  // URLだけから名前を推測し直すことになり、サイトが意図した名前と
  // 異なってしまう(実際に報告された不具合)。
  const determinedFilename = await waitForDeterminedFilename(item.id);

  // 元のダウンロードをキャンセルする
  try {
    await chrome.downloads.cancel(item.id);
  } catch (e) {
    // 極端に小さいファイル等で、キャンセルする前に完了してしまった場合はここに来る。
    // 既に保存済みのファイルを誤って消さないよう、何もせず終了する。
    console.warn("キャンセルできませんでした(既にダウンロード完了の可能性):", url, e);
    return;
  }

  // 履歴/シェルフからの削除を試みる。これはあくまで見た目の後片付けなので、
  // 失敗しても(バグ修正前は再ダウンロード自体を止めてしまっていた)
  // 再ダウンロード処理は必ず続行する。
  try {
    await chrome.downloads.erase({ id: item.id });
  } catch (e) {
    console.warn("ダウンロード履歴の削除に失敗しました(無視して続行します):", e);
  }

  // 【注】ここで determinedFilename (Chromeが本来決定するはずだった名前)を
  // 明示的に指定することで、保存ダイアログにサイトが意図した名前が表示される。
  // 取得できなかった場合(タイムアウト等)は、従来どおりChromeの自動判定に任せる。
  //
  // 【重大バグ修正】以前はこの download() 呼び出しを待たずに(fire-and-forget)
  // ハンドラを終えていたため、ロックが早く解放されすぎて、同じURLへの
  // 別の同時ダウンロードの処理と競合する隙間が生まれていた。
  // ここで呼び出し結果(新しいダウンロードID)を待ってから記録することで、
  // ロックが解放される前に「このIDは自分の再発行分だ」という登録を
  // 確実に完了させる。
  const newDownloadId = await new Promise((resolve) => {
    chrome.downloads.download(
      {
        url: url,
        filename: determinedFilename || undefined,
        saveAs: true,
      },
      (id) => {
        if (chrome.runtime.lastError) {
          console.warn(
            "再ダウンロードに失敗しました(ログイン情報付きURLやblob URL等では起こりえます):",
            chrome.runtime.lastError.message,
            url
          );
          resolve(undefined);
          return;
        }
        resolve(id);
      }
    );
  });

  if (typeof newDownloadId === "number") {
    await markExpectedId(newDownloadId);
    // このダウンロードが「保存ダイアログでキャンセルされて中断状態のまま
    // 履歴に残る」ことのないよう、状態変化を監視できるようIDを記録しておく。
    await markOwned(newDownloadId);
  }
}));

// 【重大バグ修正】自分がsaveAs付きで再発行したダウンロードが、
// ユーザーによる保存ダイアログのキャンセル等で interrupted(中断)状態に
// なった場合、履歴に残ったままにせず即座に消去する。
// (「完了」状態になった場合は、正常に保存されたということなので
//  履歴に残しておいて問題ない。追跡対象からは外すのみ。)
chrome.downloads.onChanged.addListener((delta) => withLock(async () => {
  if (!delta || !delta.state || typeof delta.id !== "number") return;
  if (!(await isOwned(delta.id))) return;

  const current = delta.state.current;
  if (current === "interrupted") {
    await unmarkOwned(delta.id);
    try {
      await chrome.downloads.erase({ id: delta.id });
    } catch (e) {
      console.warn(
        "キャンセルされたダウンロードの後片付け(履歴からの削除)に失敗しました:",
        delta.id,
        e
      );
    }
  } else if (current === "complete") {
    await unmarkOwned(delta.id);
  }
}));
