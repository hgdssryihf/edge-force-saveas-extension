// test-harness.js
// background.js のロジックを、chrome.* APIのモックを使って検証する。
"use strict";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

// background.js の MAX_INTERCEPT_ATTEMPTS と合わせること
const MAX_ATTEMPTS_FOR_TEST = 3;

function makeMockChrome(opts = {}) {
  const calls = {
    cancel: [],
    erase: [],
    download: [],
    downloadIds: [],
  };
  const listeners = {
    onCreated: [],
    onChanged: [],
    onClicked: [],
    onInstalled: [],
    onStartup: [],
  };
  const localStore = { enabled: opts.enabled !== undefined ? opts.enabled : true };
  const sessionStore = {};

  const chrome = {
    i18n: {
      getMessage: (key) => ({ badgeOn: "ON", badgeOff: "OFF" }[key] || key),
    },
    runtime: {
      lastError: undefined,
      onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
      onStartup: { addListener: (fn) => listeners.onStartup.push(fn) },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: localStore[key] }),
        set: async (obj) => Object.assign(localStore, obj),
      },
      session: {
        get: async (key) => ({ [key]: sessionStore[key] }),
        set: async (obj) => Object.assign(sessionStore, obj),
      },
    },
    action: {
      onClicked: { addListener: (fn) => listeners.onClicked.push(fn) },
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    windows: {
      // デフォルトはウィンドウが1つ開いている通常の状態。
      // opts.windowCount: 0 で「バックグラウンドのみで実行中」を再現できる。
      getAll: async () =>
        Array.from({ length: opts.windowCount ?? 1 }, (_, i) => ({ id: i })),
    },
    downloads: {
      onCreated: { addListener: (fn) => listeners.onCreated.push(fn) },
      onChanged: { addListener: (fn) => listeners.onChanged.push(fn) },
      cancel: async (id) => {
        calls.cancel.push(id);
        if (opts.cancelShouldFail && opts.cancelShouldFail(id)) {
          throw new Error("mock cancel failure (already complete)");
        }
      },
      erase: async (query) => {
        calls.erase.push(query);
        if (opts.eraseShouldFail && opts.eraseShouldFail(query)) {
          throw new Error("mock erase failure");
        }
      },
      download: (options, callback) => {
        calls.download.push(options);
        const newId = calls.download.length + 1000;
        calls.downloadIds.push(newId);
        if (opts.downloadShouldFail && opts.downloadShouldFail(options)) {
          chrome.runtime.lastError = { message: "mock download failure" };
          callback && callback(undefined);
          chrome.runtime.lastError = undefined;
          return;
        }
        // ブラウザが新しいDownloadItemを生成し、onCreatedを発火させる挙動を再現。
        // (非同期タイミングを再現するため setImmediate を使用)
        setImmediate(() => {
          for (const fn of listeners.onCreated) {
            fn({ id: newId, url: options.url, filename: "" });
          }
        });
        callback && callback(newId);
      },
    },
  };
  function fireChanged(id, currentState) {
    for (const fn of listeners.onChanged) {
      fn({ id, state: { current: currentState } });
    }
  }

  return { chrome, calls, listeners, localStore, sessionStore, fireChanged };
}

function loadBackgroundScript(chrome) {
  const code = fs.readFileSync("./background.js", "utf8");
  const sandbox = { chrome, console, setTimeout, setImmediate, Promise };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "background.js" });
  return sandbox;
}

async function wait(ms = 0) {
  return new Promise((resolve) => setImmediate(resolve, ms));
}

(async () => {
  // --- テスト1: 通常フロー ---
  // 元のダウンロードが検知されたら、cancel→erase→saveAs付きdownloadが
  // 1回ずつ呼ばれ、再ダウンロードのonCreatedでは二重にcancelされない(無限ループしない)こと。
  {
    const { chrome, calls, listeners } = makeMockChrome();
    loadBackgroundScript(chrome);
    const url = "https://example.com/file1.pdf";
    listeners.onCreated[0]({ id: 1, url, filename: "" });
    await wait();
    await wait();

    assert.strictEqual(calls.cancel.length, 1, "cancelは1回だけ呼ばれるべき");
    assert.strictEqual(calls.erase.length, 1, "eraseは1回だけ呼ばれるべき");
    assert.strictEqual(calls.download.length, 1, "downloadは1回だけ呼ばれるべき(無限ループしない)");
    assert.strictEqual(calls.download[0].saveAs, true, "saveAs:trueで再ダウンロードされるべき");
    console.log("テスト1 (通常フロー): PASS");
  }

  // --- テスト2: erase失敗時でも再ダウンロードは実行されるべき(修正前のバグ) ---
  {
    const { chrome, calls, listeners } = makeMockChrome({
      eraseShouldFail: () => true,
    });
    loadBackgroundScript(chrome);
    const url = "https://example.com/file2.pdf";
    listeners.onCreated[0]({ id: 2, url, filename: "" });
    await wait();
    await wait();

    assert.strictEqual(calls.cancel.length, 1, "cancelは呼ばれるべき");
    assert.strictEqual(
      calls.download.length,
      1,
      "eraseが失敗しても再ダウンロード(download)は実行されるべき"
    );
    console.log("テスト2 (erase失敗時も継続): PASS");
  }

  // --- テスト3: cancel失敗時(既に完了済み)は再ダウンロードしない ---
  {
    const { chrome, calls, listeners } = makeMockChrome({
      cancelShouldFail: () => true,
    });
    loadBackgroundScript(chrome);
    const url = "https://example.com/file3.pdf";
    listeners.onCreated[0]({ id: 3, url, filename: "" });
    await wait();
    await wait();

    assert.strictEqual(calls.erase.length, 0, "cancel失敗時はeraseを呼ぶべきではない");
    assert.strictEqual(
      calls.download.length,
      0,
      "cancel失敗時(既にダウンロード完了)は再ダウンロードすべきではない"
    );
    console.log("テスト3 (cancel失敗時は何もしない): PASS");
  }

  // --- テスト4: OFF(無効化)時は何もしない ---
  {
    const { chrome, calls, listeners } = makeMockChrome({ enabled: false });
    loadBackgroundScript(chrome);
    const url = "https://example.com/file4.pdf";
    listeners.onCreated[0]({ id: 4, url, filename: "" });
    await wait();
    await wait();

    assert.strictEqual(calls.cancel.length, 0, "OFF時はcancelを呼ぶべきではない");
    console.log("テスト4 (OFF時は無効): PASS");
  }

  // --- テスト5: 同じURLへの同時ダウンロード(件数管理)が破綻しないこと ---
  {
    const { chrome, calls, listeners } = makeMockChrome();
    loadBackgroundScript(chrome);
    const url = "https://example.com/same.pdf";
    listeners.onCreated[0]({ id: 5, url, filename: "" });
    listeners.onCreated[0]({ id: 6, url, filename: "" });
    await wait();
    await wait();
    await wait();

    assert.strictEqual(calls.cancel.length, 2, "同じURLの同時ダウンロードは両方ともcancelされるべき");
    assert.strictEqual(calls.download.length, 2, "同じURLの同時ダウンロードは両方とも再ダウンロードされるべき");
    console.log("テスト5 (同一URL同時ダウンロード): PASS");
  }

  // --- テスト6: 開いているウィンドウが無い(バックグラウンド実行のみ)場合は
  //     横取りしない ---
  // これが今回報告された「ブラウザを閉じると大量の.tempファイルが延々と
  // 作られる」バグの直接の再現・修正確認テスト。
  {
    const { chrome, calls, listeners } = makeMockChrome({ windowCount: 0 });
    loadBackgroundScript(chrome);
    const url = "https://example.com/file6.pdf";
    listeners.onCreated[0]({ id: 6, url, filename: "" });
    await wait();
    await wait();

    assert.strictEqual(
      calls.cancel.length,
      0,
      "ウィンドウが無い場合はcancelを呼ぶべきではない(=横取りしない)"
    );
    assert.strictEqual(
      calls.download.length,
      0,
      "ウィンドウが無い場合はdownloadを呼ぶべきではない(=saveAsダイアログを試みない)"
    );
    console.log("テスト6 (ウィンドウ無し時は横取りしない): PASS");
  }

  // --- テスト7: 同じURLへの横取りが繰り返されすぎたら自動的にあきらめる(安全装置) ---
  {
    const { chrome, calls, listeners } = makeMockChrome();
    loadBackgroundScript(chrome);
    const url = "https://example.com/repeated.pdf";
    // 同じURLへの「新規の」ダウンロードが短時間に5回発生したと仮定
    // (原因を問わず、無限/過剰な横取りが起きないことを保証するテスト)
    for (let i = 0; i < 5; i++) {
      listeners.onCreated[0]({ id: 100 + i, url, filename: "" });
      await wait();
      await wait();
    }

    assert.strictEqual(
      calls.cancel.length,
      MAX_ATTEMPTS_FOR_TEST,
      `上限(${MAX_ATTEMPTS_FOR_TEST}回)を超えて横取りするべきではない`
    );
    console.log("テスト7 (過剰な横取りは自動的に停止): PASS");
  }

  // --- テスト8: 保存ダイアログでキャンセルされたら、履歴からも消去する ---
  // (「.tempファイルが残って再ダウンロードが始まる」バグへの対策の検証)
  {
    const { chrome, calls, listeners, fireChanged } = makeMockChrome();
    loadBackgroundScript(chrome);
    const url = "https://example.com/canceled-by-user.pdf";
    listeners.onCreated[0]({ id: 8, url, filename: "" });
    await wait();
    await wait();

    // この時点で: 元のダウンロード(id:8)はcancel+erase済み、
    // 再ダウンロード(saveAs付き)が1件発行されているはず。
    assert.strictEqual(calls.download.length, 1, "再ダウンロードが1回発行されているべき");
    const redownloadId = calls.downloadIds[0];

    // ユーザーが保存ダイアログで「キャンセル」を選んだ状況を再現
    fireChanged(redownloadId, "interrupted");
    await wait();
    await wait();

    assert.strictEqual(
      calls.erase.filter((q) => q.id === redownloadId).length,
      1,
      "キャンセルされた再ダウンロードは履歴から消去されるべき(残存を防ぐ)"
    );
    console.log("テスト8 (キャンセル時の後片付け): PASS");
  }

  // --- テスト9: 開始時刻が古いダウンロードは横取りしない ---
  // (「再起動すると過去のファイルが再ダウンロードされる」バグへの対策A)
  {
    const { chrome, calls, listeners } = makeMockChrome();
    loadBackgroundScript(chrome);
    const url = "https://example.com/old-download.pdf";
    const oldStartTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1時間前
    listeners.onCreated[0]({ id: 9, url, filename: "", startTime: oldStartTime });
    await wait();
    await wait();

    assert.strictEqual(
      calls.cancel.length,
      0,
      "開始時刻が古いダウンロードはcancelされるべきではない(横取りしない)"
    );
    console.log("テスト9 (開始時刻が古いダウンロードは横取りしない): PASS");
  }

  // --- テスト10: ブラウザ起動直後の猶予期間中は横取りしない ---
  // (「再起動すると過去のファイルが再ダウンロードされる」バグへの対策B)
  {
    const { chrome, calls, listeners } = makeMockChrome();
    loadBackgroundScript(chrome);
    // chrome.runtime.onStartup が発火した直後の状況を再現
    for (const fn of listeners.onStartup) await fn();
    await wait();

    const url = "https://example.com/right-after-startup.pdf";
    const freshStartTime = new Date().toISOString();
    listeners.onCreated[0]({ id: 10, url, filename: "", startTime: freshStartTime });
    await wait();
    await wait();

    assert.strictEqual(
      calls.cancel.length,
      0,
      "起動直後の猶予期間中はcancelされるべきではない(横取りしない)"
    );
    console.log("テスト10 (起動直後の猶予期間中は横取りしない): PASS");
  }

  console.log("\n全テスト成功");
})().catch((err) => {
  console.error("テスト失敗:", err);
  process.exit(1);
});
