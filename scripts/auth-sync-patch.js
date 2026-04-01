(function () {
  var AUTH_BUTTON_LABEL = "\u0410\u0412\u0422\u041e\u0420\u0418\u0417\u041e\u0412\u0410\u0422\u042c\u0421\u042f";
  var AUTH_STATE_ENDPOINT = "/api/telegram/get-state";
  var REPORT_AUTH_ENDPOINT = "/api/telegram/report-auth";
  var BOT_URL_STORAGE_KEY = "__HAR_BOT_URL__";
  var DEFAULT_BOT_API_BASE = "http://localhost:3000";
  var STORAGE_PREFIX = "__HAR_AUTHORIZED__";
  var state = {
    knownAuthorized: false,
    autoHandled: false,
    serverCheckedUserId: null,
    currentUserId: null
  };

  function parseInitDataUser(raw) {
    try {
      var params = new URLSearchParams(String(raw || ""));
      var user = JSON.parse(params.get("user") || "null");
      var userId = Number(user && user.id);

      if (!Number.isInteger(userId) || userId <= 0) {
        return null;
      }

      return {
        id: userId,
        username: user.username || null,
        first_name: user.first_name || user.firstName || null,
        last_name: user.last_name || user.lastName || null
      };
    } catch (error) {
      return null;
    }
  }

  function getStoredTokenUser() {
    try {
      var token = localStorage.getItem("refresh_token");
      var userId = Number(token);

      if (!Number.isInteger(userId) || userId <= 0) {
        return null;
      }

      return {
        id: userId,
        username: null,
        first_name: localStorage.getItem("user_first_name") || null,
        last_name: null
      };
    } catch (error) {
      return null;
    }
  }

  function getTelegramUser() {
    var tg = window.Telegram && window.Telegram.WebApp;
    var user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    var userId = Number(user && user.id);

    if (Number.isInteger(userId) && userId > 0) {
      return {
        id: userId,
        username: user.username || null,
        first_name: user.first_name || user.firstName || null,
        last_name: user.last_name || user.lastName || null
      };
    }

    return parseInitDataUser(tg && tg.initData) || getStoredTokenUser();
  }

  function getPlatform() {
    var tg = window.Telegram && window.Telegram.WebApp;
    return (tg && tg.platform) || navigator.userAgent || "unknown";
  }

  function getBotApiBase() {
    try {
      var stored = localStorage.getItem(BOT_URL_STORAGE_KEY);
      if (stored) {
        return String(stored).replace(/\/$/, "");
      }
    } catch (error) {
      /* ignore storage failures */
    }

    return DEFAULT_BOT_API_BASE;
  }

  function toBotApiUrl(path) {
    if (/^https?:\/\//i.test(String(path || ""))) {
      return path;
    }

    return getBotApiBase() + (String(path || "").charAt(0) === "/" ? path : "/" + path);
  }

  function getStorageKey(user) {
    return STORAGE_PREFIX + ":" + (user && user.id ? String(user.id) : "unknown");
  }

  function readAuthorizedFlag(user) {
    try {
      return localStorage.getItem(getStorageKey(user)) === "1";
    } catch (error) {
      return false;
    }
  }

  function writeAuthorizedFlag(user, value) {
    if (!user || !user.id) {
      return;
    }

    try {
      localStorage.setItem(getStorageKey(user), value ? "1" : "0");
    } catch (error) {
      /* ignore storage failures */
    }
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
  }

  function isAuthButton(element) {
    return element instanceof HTMLElement && normalizeText(element.textContent) === AUTH_BUTTON_LABEL;
  }

  function findAuthButton(root) {
    var scope = root || document;
    var buttons = scope.querySelectorAll ? scope.querySelectorAll("button, [role='button']") : [];

    for (var i = 0; i < buttons.length; i += 1) {
      if (isAuthButton(buttons[i])) {
        return buttons[i];
      }
    }

    return null;
  }

  function findAuthButtonFromTarget(target) {
    var element = target instanceof Element ? target : null;

    while (element) {
      if (isAuthButton(element)) {
        return element;
      }

      element = element.parentElement;
    }

    return null;
  }

  function postJson(url, body) {
    return fetch(toBotApiUrl(url), {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  }

  function reportAuthorized(user) {
    if (!user || !user.id) {
      return Promise.resolve();
    }

    return postJson(REPORT_AUTH_ENDPOINT, {
      user: user,
      platform: getPlatform(),
      ts: Date.now()
    }).catch(function () {
      return null;
    });
  }

  function markAuthorized(user) {
    if (!user || !user.id) {
      return;
    }

    state.knownAuthorized = true;
    writeAuthorizedFlag(user, true);
    reportAuthorized(user);
  }

  function tryAutoConfirm() {
    if (!state.knownAuthorized || state.autoHandled) {
      return;
    }

    var authButton = findAuthButton(document);
    if (!authButton) {
      return;
    }

    state.autoHandled = true;
    authButton.click();
  }

  function syncLocalState(user) {
    if (!user || !user.id) {
      return;
    }

    if (state.currentUserId !== user.id) {
      state.currentUserId = user.id;
      state.serverCheckedUserId = null;
      state.autoHandled = false;
      state.knownAuthorized = false;
    }
  }

  function restoreAuthorizedState() {
    var user = getTelegramUser();

    if (!user || !user.id) {
      return;
    }

    syncLocalState(user);

    if (state.serverCheckedUserId === user.id) {
      tryAutoConfirm();
      return;
    }

    state.serverCheckedUserId = user.id;

    postJson(AUTH_STATE_ENDPOINT, {
      user: user,
      platform: getPlatform(),
      ts: Date.now()
    })
      .then(function (response) {
        if (!response || !response.ok) {
          return null;
        }

        return response.json();
      })
      .then(function (data) {
        if (!data || !data.ok) {
          return;
        }

        if (!data.known) {
          state.knownAuthorized = false;
          writeAuthorizedFlag(user, false);
          return;
        }

        state.knownAuthorized = true;
        writeAuthorizedFlag(user, true);
        tryAutoConfirm();
      })
      .catch(function () {
        return null;
      });
  }

  document.addEventListener(
    "click",
    function (event) {
      var authButton = findAuthButtonFromTarget(event.target);
      if (!authButton) {
        return;
      }

      markAuthorized(getTelegramUser());
      window.setTimeout(function () {
        markAuthorized(getTelegramUser());
      }, 250);
    },
    true
  );

  var observer = new MutationObserver(function () {
    restoreAuthorizedState();
    tryAutoConfirm();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", restoreAuthorizedState, { once: true });
  } else {
    restoreAuthorizedState();
  }

  window.addEventListener("load", restoreAuthorizedState, { once: true });
  window.setTimeout(restoreAuthorizedState, 300);
  window.setTimeout(restoreAuthorizedState, 1200);
})();
