(function () {
    const OFFLINE = { "siteHost": "litenergy4.ru", "launch": { "query_id": "offline-har-snapshot", "auth_date": 1774473288, "signature": "offline-har-signature", "hash": "offline-har-hash", "version": "9.5", "platform": "web", "themeParams": { "bg_color": "#212121", "button_color": "#8774e1", "button_text_color": "#ffffff", "hint_color": "#aaaaaa", "link_color": "#8774e1", "secondary_bg_color": "#181818", "text_color": "#ffffff", "header_bg_color": "#212121", "accent_text_color": "#8774e1", "section_bg_color": "#212121", "section_header_text_color": "#8774e1", "subtitle_text_color": "#aaaaaa", "destructive_text_color": "#ff595a" }, "user": { "id": 1471687849, "first_name": "Andrew", "last_name": "Curtis", "username": "Rat_IV", "language_code": "ru", "allows_write_to_pm": true } }, "api": { "tokens": { "status": 200, "body": { "access_token": "offline-access-token", "refresh_token": "offline-refresh-token" } }, "me": { "status": 200, "body": { "balance": 0, "available_spins": 1, "gift_expires_at": "2026-03-26T20:12:03.391487", "card_number": "" } }, "results": { "status": 200, "body": { "spin": "714_000", "amount": 714000 } }, "stages": { "status": 200, "body": { "payment_stage": 0, "start_chat_stage": 0, "checking_stage": 0, "withdrawal_chat_stage": 0, "bank_commission_stage": 0, "signature_stage": 0 } }, "invoices": [{ "status": 200, "request": { "method": "stars", "amount": 1080, "title": "Активацию личной подписи", "next_stages": { "signature_stage": 3 } }, "body": { "link": "https://t.me/$5g83J1btKUqgFgAArbBxVw_nIws" } }, { "status": 200, "request": { "method": "stars", "amount": 936, "title": "Получение пин-кода" }, "body": { "link": "https://t.me/$pcFQHVbtKUqhFgAAA55JC39c360" } }, { "status": 200, "request": { "method": "stars", "amount": 1104, "title": "Активацию пин-кода" }, "body": { "link": "https://t.me/$LcYDJ1btKUqfFgAAQhrvsC8RD4o" } }] }, "missingAssetPaths": ["/chat/avatar.png", "/chat/user.png", "/fire-1000.png", "/modals/error/background.png", "/modals/fail/background.png", "/modals/free-attempts/background.png", "/modals/free-attempts/slots.png", "/modals/free-attempts/star.png", "/payment/support_avatars/elena.png", "/payment/support_avatars/marina.png", "/winner-prizes/cash-4.png"] };
    window.__HAR_OFFLINE_CONFIG__ = OFFLINE;
    window.__OFFLINE_MISSING_ASSET_PATHS__ = new Set(OFFLINE.missingAssetPaths);

    const noop = () => undefined;
    const noopProxy = new Proxy(noop, {
        get(target, prop) {
            if (prop === "then") {
                return undefined;
            }
            return noopProxy;
        },
        apply() {
            return undefined;
        },
    });

    window.posthog = noopProxy;

    const chatReplies = [
        {
            name: "Оператор",
            text: "Сообщение получено. Продолжайте оформление выплаты по инструкции на экране.",
            color: "lime",
        },
        {
            name: "Поддержка",
            text: "Для офлайн-копии переходы по окнам смоделированы локально. Можно продолжать сценарий.",
            color: "blue",
        },
        {
            name: "Модератор",
            text: "Текущий шаг сохранен локально в браузере этой вкладки.",
            color: "purple",
        },
    ];

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function safeParseJson(value, fallback) {
        try {
            return JSON.parse(value);
        } catch (error) {
            return fallback;
        }
    }

    const STORAGE = {
        session: {
            startFlow: {
                key: "__HAR_OFFLINE_STATE_V3_START_FLOW__",
                defaults: {
                    auth: clone(OFFLINE.api.tokens.body),
                    me: clone(OFFLINE.api.me.body),
                    stages: clone(OFFLINE.api.stages.body),
                    currentResult: clone(OFFLINE.api.results.body),
                    resultConsumed: false,
                    spinFinished: false,
                    chatReplyIndex: 0,
                },
            },
        },
        local: {
            cloud: {
                keyPrefix: "__HAR_OFFLINE_CLOUD__:",
            },
        },
    };
    window.__HAR_OFFLINE_STORAGE__ = STORAGE;

    const CHAT_COLORS = ["pink", "blue", "purple", "lime"];

    function getRuntimeAssetUrl(pathname) {
        const currentScript = document.currentScript;
        if (currentScript && currentScript.src) {
            return new URL(pathname, currentScript.src).toString();
        }
        return new URL(pathname, window.location.href).toString();
    }

    function getChatSeedLookupKey(message) {
        return JSON.stringify([
            message && (message.name || message.author || ""),
            message && message.text ? message.text : "",
        ]);
    }

    function resolveChatSeedColor(message, index) {
        if (message && CHAT_COLORS.includes(message.color)) {
            return message.color;
        }

        const seed = (message && (message.name || message.author || ""))
            .split("")
            .reduce((total, char) => total + char.charCodeAt(0), index);

        return CHAT_COLORS[Math.abs(seed) % CHAT_COLORS.length];
    }

    function normalizeChatSeedImage(imageSrc) {
        if (!imageSrc) {
            return undefined;
        }

        try {
            const url = new URL(imageSrc, window.location.href);
            if (url.hostname === OFFLINE.siteHost || url.origin === window.location.origin) {
                return url.pathname;
            }
            return url.toString();
        } catch (error) {
            return imageSrc;
        }
    }

    function normalizeChatSeedMessages(messages) {
        if (!Array.isArray(messages)) {
            return null;
        }

        const normalizedMessages = [];
        const knownMessages = new Map();

        messages.forEach((message, index) => {
            if (!message || typeof message.text !== "string") {
                return;
            }

            const normalizedMessage = {
                id: message.id || "seed-" + String(index + 1),
                author: message.name || message.author || "Пользователь",
                text: message.text,
                color: resolveChatSeedColor(message, index),
            };

            const replyTo = message.replyTo;
            if (replyTo && typeof replyTo.text === "string") {
                const replyId = knownMessages.get(getChatSeedLookupKey(replyTo));
                if (replyId !== undefined) {
                    normalizedMessage.replyId = replyId;
                }
            }

            const image = normalizeChatSeedImage(message.imageSrc || message.image);
            if (image) {
                normalizedMessage.image = image;
            }

            normalizedMessages.push(normalizedMessage);
            knownMessages.set(
                getChatSeedLookupKey({
                    name: normalizedMessage.author,
                    text: normalizedMessage.text,
                }),
                normalizedMessage.id,
            );
        });

        return normalizedMessages;
    }

    function loadChatSeedMessages() {
        try {
            const request = new XMLHttpRequest();
            request.open("GET", getRuntimeAssetUrl("chatSeedMessages.json"), false);
            request.send(null);

            if (
                (request.status >= 200 && request.status < 300) ||
                (request.status === 0 && request.responseText)
            ) {
                return normalizeChatSeedMessages(JSON.parse(request.responseText));
            }
        } catch (error) {
            console.warn("Failed to load chat seed messages:", error);
        }

        return null;
    }

    window.__HAR_CHAT_SEED_MESSAGES__ = loadChatSeedMessages();

    function buildInitialState() {
        return clone(STORAGE.session.startFlow.defaults);
    }

    function readState() {
        const fallback = buildInitialState();
        try {
            const raw = sessionStorage.getItem(STORAGE.session.startFlow.key);
            if (!raw) {
                return fallback;
            }
            return Object.assign(fallback, safeParseJson(raw, {}));
        } catch (error) {
            return fallback;
        }
    }

    const state = readState();

    function persistState() {
        try {
            sessionStorage.setItem(STORAGE.session.startFlow.key, JSON.stringify(state));
        } catch (error) {
            // Ignore storage failures in private or restricted contexts.
        }
    }

    function setCloudValue(key, value) {
        localStorage.setItem(STORAGE.local.cloud.keyPrefix + key, value);
    }

    function getCloudValue(key) {
        return localStorage.getItem(STORAGE.local.cloud.keyPrefix + key) || "";
    }

    function getCloudKeys() {
        return Object.keys(localStorage)
            .filter((key) => key.startsWith(STORAGE.local.cloud.keyPrefix))
            .map((key) => key.slice(STORAGE.local.cloud.keyPrefix.length));
    }

    function deleteCloudValues(keys) {
        keys.forEach((key) => {
            localStorage.removeItem(STORAGE.local.cloud.keyPrefix + key);
        });
    }

    function dispatchTelegramEvent(eventType, eventData) {
        window.dispatchEvent(
            new MessageEvent("message", {
                data: JSON.stringify({ eventType, eventData }),
                source: window.parent,
            }),
        );
    }

    function buildInitDataRaw() {
        const user = {
            id: OFFLINE.launch.user.id,
            first_name: OFFLINE.launch.user.first_name,
            last_name: OFFLINE.launch.user.last_name,
            username: OFFLINE.launch.user.username,
            language_code: OFFLINE.launch.user.language_code,
            allows_write_to_pm: OFFLINE.launch.user.allows_write_to_pm,
            photo_url: new URL("placeholders/missing-user-photo.svg", window.location.href).toString(),
        };

        return [
            "query_id=" + encodeURIComponent(OFFLINE.launch.query_id),
            "user=" + encodeURIComponent(JSON.stringify(user)),
            "auth_date=" + encodeURIComponent(String(OFFLINE.launch.auth_date)),
            "signature=" + encodeURIComponent(OFFLINE.launch.signature),
            "hash=" + encodeURIComponent(OFFLINE.launch.hash),
        ].join("&");
    }

    function ensureLaunchHash() {
        if (window.location.hash.includes("tgWebAppData=")) {
            return;
        }

        const params = new URLSearchParams();
        params.set("tgWebAppData", buildInitDataRaw());
        params.set("tgWebAppVersion", OFFLINE.launch.version);
        params.set("tgWebAppPlatform", OFFLINE.launch.platform);
        params.set("tgWebAppThemeParams", JSON.stringify(OFFLINE.launch.themeParams));
        history.replaceState(null, "", window.location.pathname + window.location.search + "#" + params.toString());
    }

    function offlineOpenExternal(url) {
        const target = "external-link.html?url=" + encodeURIComponent(url);
        window.location.href = target;
    }

    function respondToCustomMethod(payload) {
        let result = null;
        let error = null;
        try {
            switch (payload.method) {
                case "saveStorageValue":
                    setCloudValue(payload.params.key, payload.params.value);
                    result = true;
                    break;
                case "getStorageValues":
                    result = Object.fromEntries(
                        payload.params.keys.map((key) => [key, getCloudValue(key)]),
                    );
                    break;
                case "getStorageKeys":
                    result = getCloudKeys();
                    break;
                case "deleteStorageValues":
                    deleteCloudValues(payload.params.keys || []);
                    result = true;
                    break;
                default:
                    result = null;
            }
        } catch (customMethodError) {
            error = customMethodError instanceof Error ? customMethodError.message : String(customMethodError);
        }

        setTimeout(() => {
            dispatchTelegramEvent("custom_method_invoked", {
                req_id: payload.req_id,
                result,
                error,
            });
        }, 0);
    }

    window.__offlineOpenExternal = offlineOpenExternal;
    ensureLaunchHash();

    window.TelegramWebviewProxy = {
        postEvent(eventType, eventData) {
            let payload = eventData;
            try {
                if (typeof eventData === "string") {
                    payload = JSON.parse(eventData);
                }
            } catch (error) {
                payload = eventData;
            }

            if (eventType === "web_app_open_tg_link" && payload && payload.path_full) {
                offlineOpenExternal("https://t.me" + payload.path_full);
            }

            if (eventType === "web_app_open_link" && payload && payload.url) {
                offlineOpenExternal(payload.url);
            }

            if (eventType === "web_app_open_invoice" && payload && payload.slug) {
                setTimeout(() => {
                    dispatchTelegramEvent("invoice_closed", {
                        slug: payload.slug,
                        status: "paid",
                    });
                }, 120);
            }

            if (eventType === "web_app_invoke_custom_method" && payload && payload.req_id) {
                respondToCustomMethod(payload);
            }

            if (eventType === "web_app_request_theme") {
                setTimeout(() => {
                    dispatchTelegramEvent("theme_changed", {
                        theme_params: OFFLINE.launch.themeParams,
                    });
                }, 0);
            }
        },
    };

    function normalizeRequestBody(bodyText) {
        if (!bodyText) {
            return "";
        }

        try {
            return JSON.stringify(JSON.parse(bodyText));
        } catch (error) {
            return bodyText;
        }
    }

    function parseRequestBody(bodyText) {
        if (!bodyText) {
            return {};
        }

        try {
            return JSON.parse(bodyText);
        } catch (error) {
            return {};
        }
    }

    function buildOfflineStub(method, pathname) {
        return {
            status: 501,
            body: {
                offline_stub: true,
                detail: "Request was not captured in the HAR snapshot",
                method,
                pathname,
            },
        };
    }

    function matchApiRequest(method, url, bodyText) {
        const normalizedMethod = method.toUpperCase();
        const normalizedBody = normalizeRequestBody(bodyText);
        const body = parseRequestBody(bodyText);
        const isLocalApi = url.origin === window.location.origin && url.pathname.startsWith("/api/v1/");
        const isRemoteApi = url.hostname === OFFLINE.siteHost && url.pathname.startsWith("/api/v1/");
        if (!isLocalApi && !isRemoteApi) {
            return null;
        }

        const routeKey = normalizedMethod + " " + url.pathname;

        if (routeKey === "POST /api/v1/auth/login" || routeKey === "POST /api/v1/auth/refresh") {
            return OFFLINE.api.tokens;
        }

        if (routeKey === "GET /api/v1/me") {
            return { status: 200, body: clone(state.me) };
        }

        if (routeKey === "PATCH /api/v1/me/card-number") {
            state.me = Object.assign({}, state.me, body);
            persistState();
            return { status: 200, body: clone(state.me) };
        }

        if (routeKey === "GET /api/v1/results") {
            if (state.resultConsumed || !state.currentResult) {
                return { status: 422, body: { detail: "No spins available" } };
            }
            return { status: 200, body: clone(state.currentResult) };
        }

        if (routeKey === "POST /api/v1/finish") {
            if (!state.spinFinished && state.currentResult) {
                state.me.available_spins = Math.max(0, (state.me.available_spins || 0) - 1);
                if (state.currentResult.spin === "attempts") {
                    state.me.available_spins += state.currentResult.attempts || 3;
                } else if (typeof state.currentResult.amount === "number") {
                    state.me.balance = Math.max(state.me.balance || 0, state.currentResult.amount);
                }
                state.spinFinished = true;
                state.resultConsumed = true;
                persistState();
            }
            return { status: 200, body: { status: "ok" } };
        }

        if (routeKey === "GET /api/v1/stages") {
            return { status: 200, body: clone(state.stages) };
        }

        if (routeKey === "PATCH /api/v1/stages") {
            state.stages = Object.assign({}, state.stages, body);
            persistState();
            return { status: 200, body: clone(state.stages) };
        }

        if (routeKey === "POST /api/v1/invoice") {
            const matchedInvoice = OFFLINE.api.invoices.find((invoice) => normalizeRequestBody(JSON.stringify(invoice.request)) === normalizedBody);
            if (matchedInvoice) {
                return matchedInvoice;
            }
            return {
                status: 200,
                body: {
                    link: "https://t.me/$offlineInvoice",
                },
            };
        }

        if (routeKey === "POST /api/v1/chat/message") {
            const reply = chatReplies[state.chatReplyIndex % chatReplies.length];
            state.chatReplyIndex += 1;
            persistState();
            return {
                status: 200,
                body: {
                    name: reply.name,
                    text: reply.text,
                    color: reply.color,
                    echo: body.text || "",
                },
            };
        }

        return buildOfflineStub(normalizedMethod, url.pathname);
    }

    function isPosthogRequest(url) {
        return /(^|\.)posthog\.com$/i.test(url.hostname) || url.hostname.includes("posthog");
    }

    function jsonResponse(payload) {
        return new Response(JSON.stringify(payload.body), {
            status: payload.status,
            headers: {
                "content-type": "application/json; charset=utf-8",
                "x-offline-har": "true",
            },
        });
    }

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function offlineFetch(input, init) {
        const request = input instanceof Request ? input : null;
        const url = new URL(request ? request.url : String(input), window.location.href);
        const method = (init && init.method) || (request && request.method) || "GET";
        let bodyText = "";

        if (init && typeof init.body === "string") {
            bodyText = init.body;
        } else if (init && init.body instanceof URLSearchParams) {
            bodyText = init.body.toString();
        } else if (request && request.method !== "GET" && request.method !== "HEAD") {
            try {
                bodyText = await request.clone().text();
            } catch (error) {
                bodyText = "";
            }
        }

        const apiMatch = matchApiRequest(method, url, bodyText);
        if (apiMatch) {
            return jsonResponse(apiMatch);
        }

        if (isPosthogRequest(url)) {
            return jsonResponse({ status: 200, body: { status: "Offline stub" } });
        }

        return nativeFetch(input, init);
    };

    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSend = XMLHttpRequest.prototype.send;
    const xhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function offlineOpen(method, url) {
        this.__offlineRequest = {
            method,
            url,
            headers: {},
        };
        return xhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function offlineSetRequestHeader(name, value) {
        if (this.__offlineRequest) {
            this.__offlineRequest.headers[name] = value;
        }
        return xhrSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function offlineSend(body) {
        if (!this.__offlineRequest) {
            return xhrSend.apply(this, arguments);
        }

        const method = this.__offlineRequest.method || "GET";
        const url = new URL(this.__offlineRequest.url, window.location.href);
        const bodyText = typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : "";
        const apiMatch = matchApiRequest(method, url, bodyText);
        const payload = apiMatch || (isPosthogRequest(url) ? { status: 200, body: { status: "Offline stub" } } : null);

        if (!payload) {
            return xhrSend.apply(this, arguments);
        }

        const responseText = JSON.stringify(payload.body);
        Object.defineProperty(this, "readyState", { configurable: true, value: 4 });
        Object.defineProperty(this, "status", { configurable: true, value: payload.status });
        Object.defineProperty(this, "statusText", { configurable: true, value: String(payload.status) });
        Object.defineProperty(this, "responseText", { configurable: true, value: responseText });
        Object.defineProperty(this, "response", { configurable: true, value: responseText });
        Object.defineProperty(this, "responseURL", { configurable: true, value: url.toString() });

        queueMicrotask(() => {
            if (typeof this.onreadystatechange === "function") {
                this.onreadystatechange();
            }
            if (typeof this.onload === "function") {
                this.onload();
            }
            if (typeof this.onloadend === "function") {
                this.onloadend();
            }
        });
    };

    persistState();
})();
