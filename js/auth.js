// ===== FBA 装箱优化工具 — 认证 & 数据持久化 =====

// Use relative URL when served by backend, fallback to localhost for dev
const API_BASE = window.location.origin.startsWith('http') && window.location.port !== '8000' && window.location.port !== ''
    ? 'http://localhost:8000'
    : '';

// ── Toast ─────────────────────────────────────────────

function showToast(message, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + (type === 'error' ? 'error' : 'success');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
        toast.classList.add('toast-hiding');
        toast.addEventListener('animationend', function () { toast.remove(); });
    }, 3000);
}

// ── API Client ────────────────────────────────────────

var api = {
    getToken: function () { return localStorage.getItem('fba_token'); },
    setToken: function (t) { localStorage.setItem('fba_token', t); },
    clearToken: function () { localStorage.removeItem('fba_token'); },

    _fetch: async function (method, path, body) {
        var headers = { 'Content-Type': 'application/json' };
        var token = api.getToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;

        var opts = { method: method, headers: headers };
        if (body) opts.body = JSON.stringify(body);

        var res = await fetch(API_BASE + path, opts);
        var data;
        try { data = await res.json(); } catch (e) { data = { detail: '请求失败' }; }

        if (!res.ok) {
            if (res.status === 401 && token) {
                api.clearToken();
                currentUser = null;
                updateAuthUI();
                showAuthModal('login');
            }
            throw new Error(data.detail || '请求失败 (' + res.status + ')');
        }
        return data;
    },

    register: function (username, password) {
        return api._fetch('POST', '/api/auth/register', { username: username, password: password });
    },
    login: function (username, password) {
        return api._fetch('POST', '/api/auth/login', { username: username, password: password });
    },
    saveData: function (name, skusData, boxesData, groupsData, resultData) {
        return api._fetch('POST', '/api/box-data', {
            name: name,
            skus_data: skusData,
            box_types_data: boxesData,
            mixed_groups_data: groupsData,
            result_data: resultData || null,
        });
    },
    getHistory: function () {
        return api._fetch('GET', '/api/box-data');
    },
    getDataDetail: function (id) {
        return api._fetch('GET', '/api/box-data/' + id);
    },
    deleteData: function (id) {
        return api._fetch('DELETE', '/api/box-data/' + id);
    },
};

// ── Auth State ────────────────────────────────────────

var currentUser = null;

// ── Auth Modal ────────────────────────────────────────

function showAuthModal(tab) {
    tab = tab || 'login';
    var overlay = document.getElementById('authModal');
    if (!overlay) return;
    overlay.classList.add('active');

    var loginTab = document.getElementById('authTabLogin');
    var registerTab = document.getElementById('authTabRegister');
    var loginForm = document.getElementById('authFormLogin');
    var registerForm = document.getElementById('authFormRegister');
    var errorDiv = overlay.querySelector('.modal-error');

    if (errorDiv) errorDiv.classList.remove('visible');

    if (tab === 'login') {
        loginTab.classList.add('active');
        registerTab.classList.remove('active');
        loginForm.classList.add('active');
        registerForm.classList.remove('active');
    } else {
        registerTab.classList.add('active');
        loginTab.classList.remove('active');
        registerForm.classList.add('active');
        loginForm.classList.remove('active');
    }
}

function hideAuthModal() {
    var overlay = document.getElementById('authModal');
    if (overlay) overlay.classList.remove('active');
}

async function handleAuthSubmit() {
    var overlay = document.getElementById('authModal');
    if (!overlay) return;
    var errorDiv = overlay.querySelector('.modal-error');
    var isLogin = document.getElementById('authTabLogin').classList.contains('active');

    var username, password;
    if (isLogin) {
        username = document.getElementById('loginUsername').value.trim();
        password = document.getElementById('loginPassword').value;
    } else {
        username = document.getElementById('registerUsername').value.trim();
        password = document.getElementById('registerPassword').value;
    }

    if (!username || username.length < 3) {
        if (errorDiv) { errorDiv.textContent = '用户名至少 3 个字符'; errorDiv.classList.add('visible'); }
        return;
    }
    if (!password || password.length < 6) {
        if (errorDiv) { errorDiv.textContent = '密码至少 6 个字符'; errorDiv.classList.add('visible'); }
        return;
    }

    try {
        var data;
        if (isLogin) {
            data = await api.login(username, password);
        } else {
            data = await api.register(username, password);
        }
        api.setToken(data.token);
        currentUser = { id: data.id, username: data.username };
        updateAuthUI();
        hideAuthModal();
        showToast((isLogin ? '登录成功' : '注册成功') + '，欢迎 ' + data.username, 'success');
    } catch (e) {
        if (errorDiv) { errorDiv.textContent = e.message; errorDiv.classList.add('visible'); }
    }
}

function handleLogout() {
    api.clearToken();
    currentUser = null;
    updateAuthUI();
    showToast('已退出登录', 'success');
}

// ── History Modal ─────────────────────────────────────

async function showHistoryModal() {
    if (!currentUser) {
        showAuthModal('login');
        return;
    }

    var overlay = document.getElementById('historyModal');
    if (!overlay) return;
    overlay.classList.add('active');

    var list = document.getElementById('historyList');
    if (!list) return;
    list.innerHTML = '<div class="loading">加载中...</div>';

    try {
        var items = await api.getHistory();
        if (items.length === 0) {
            list.innerHTML = '<div class="history-empty">还没有保存的记录</div>';
            return;
        }
        list.innerHTML = items.map(function (item) {
            return '<div class="history-entry">' +
                '<div class="history-entry-info">' +
                '<div class="history-entry-name">' + escapeHtml(item.name) + '</div>' +
                '<div class="history-entry-date">' + escapeHtml(item.created_at) + '</div>' +
                '</div>' +
                '<div class="history-entry-actions">' +
                '<button class="btn btn-sm btn-primary" onclick="loadHistoryEntry(' + item.id + ')">加载</button>' +
                '<button class="btn btn-sm btn-danger" onclick="deleteHistoryEntry(' + item.id + ')">删除</button>' +
                '</div>' +
                '</div>';
        }).join('');
    } catch (e) {
        list.innerHTML = '<div class="history-empty" style="color:#991B1B;">加载失败: ' + escapeHtml(e.message) + '</div>';
    }
}

function hideHistoryModal() {
    var overlay = document.getElementById('historyModal');
    if (overlay) overlay.classList.remove('active');
}

async function loadHistoryEntry(id) {
    try {
        var data = await api.getDataDetail(id);

        // 1. Clear existing data
        document.querySelectorAll('#skuBody tr').forEach(function (tr) { tr.remove(); });
        boxTypes = [];
        mixedGroups = [];
        nextSkuId = 1;
        nextBoxId = 1;
        nextGroupId = 1;

        // 2. Add SKU rows
        for (var i = 0; i < data.skus_data.length; i++) {
            var sku = data.skus_data[i];
            addSkuRow({
                name: sku.name,
                length: String(sku.dimensions.length),
                width: String(sku.dimensions.width),
                height: String(sku.dimensions.height),
                qty: String(sku.quantity),
                pkg: sku.packagingType || 'hard',
                tol: sku.packagingType === 'soft' ? String(Math.round((sku.softTolerance || 0) * 100)) : '0',
            });
        }
        updateDataFromTables();

        // Build SKU ID map (match by name + dimensions)
        var skuIdMap = new Map();
        for (var s = 0; s < data.skus_data.length; s++) {
            var oldSku = data.skus_data[s];
            for (var k = 0; k < skus.length; k++) {
                var newSku = skus[k];
                if (newSku.name === oldSku.name &&
                    Math.abs(newSku.dimensions.length - oldSku.dimensions.length) < 0.02 &&
                    Math.abs(newSku.dimensions.width - oldSku.dimensions.width) < 0.02 &&
                    Math.abs(newSku.dimensions.height - oldSku.dimensions.height) < 0.02) {
                    skuIdMap.set(oldSku.id, newSku.id);
                    break;
                }
            }
        }

        // 3. Add box types
        var boxIdMap = new Map();
        for (var b = 0; b < data.box_types_data.length; b++) {
            var box = data.box_types_data[b];
            var result = addBoxRow({
                name: box.name,
                length: String(box.external.length),
                width: String(box.external.width),
                height: String(box.external.height),
                wall: String(box.wallThickness || 1.0),
            });
            if (result) boxIdMap.set(box.id, result.id);
        }

        // 4. Add mixed groups with remapped IDs
        for (var g = 0; g < data.mixed_groups_data.length; g++) {
            var group = data.mixed_groups_data[g];
            var newBoxTypeId = boxIdMap.get(group.boxTypeId) || (boxTypes.length > 0 ? boxTypes[0].id : '');
            var newAssignments = [];
            for (var a = 0; a < group.assignments.length; a++) {
                var asgn = group.assignments[a];
                newAssignments.push({
                    skuId: skuIdMap.get(asgn.skuId) || asgn.skuId,
                    qtyPerBox: asgn.qtyPerBox,
                });
            }
            addMixedGroup({
                name: group.name,
                boxTypeId: newBoxTypeId,
                boxCount: group.boxCount,
                assignments: newAssignments,
            });
        }

        hideHistoryModal();
        showToast('数据已成功加载', 'success');
        // Scroll to results
        var rs = document.getElementById('resultsSection');
        if (rs) rs.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
        showToast('加载失败: ' + e.message, 'error');
    }
}

async function deleteHistoryEntry(id) {
    if (!confirm('确定删除这条记录吗？此操作不可撤销。')) return;
    try {
        await api.deleteData(id);
        showToast('记录已删除', 'success');
        showHistoryModal(); // Refresh list
    } catch (e) {
        showToast('删除失败: ' + e.message, 'error');
    }
}

// ── Save ──────────────────────────────────────────────

async function handleSave() {
    if (!currentUser) {
        showAuthModal('login');
        return;
    }

    var name = prompt('请输入存档名称（例如：2024-Q4-FBA方案）');
    if (!name || !name.trim()) return;
    name = name.trim();

    updateDataFromTables();

    if (skus.length === 0) {
        showToast('没有可保存的 SKU 数据', 'error');
        return;
    }

    // Serialize data (strip functions, keep plain objects)
    var skusData = skus.map(function (s) { return { id: s.id, name: s.name, quantity: s.quantity, dimensions: { length: s.dimensions.length, width: s.dimensions.width, height: s.dimensions.height }, packagingType: s.packagingType, softTolerance: s.softTolerance || 0 }; });
    var boxesData = boxTypes.map(function (b) { return { id: b.id, name: b.name, external: { length: b.external.length, width: b.external.width, height: b.external.height }, wallThickness: b.wallThickness, internal: { length: b.internal.length, width: b.internal.width, height: b.internal.height } }; });
    var groupsData = mixedGroups.map(function (g) { return { id: g.id, name: g.name, boxTypeId: g.boxTypeId, boxCount: g.boxCount, assignments: g.assignments.map(function (a) { return { skuId: a.skuId, qtyPerBox: a.qtyPerBox }; }) }; });

    // Build lightweight result snapshot
    var resultData = null;
    try {
        var totalBoxes = mixedGroups.reduce(function (s, g) { return s + g.boxCount; }, 0);
        var totalAllocated = 0;
        for (var gi = 0; gi < mixedGroups.length; gi++) {
            var g = mixedGroups[gi];
            for (var ai = 0; ai < g.assignments.length; ai++) {
                totalAllocated += g.assignments[ai].qtyPerBox * g.boxCount;
            }
        }
        var totalSkus = skus.reduce(function (s, sk) { return s + sk.quantity; }, 0);
        resultData = {
            totalBoxes: totalBoxes,
            totalAllocated: totalAllocated,
            totalSkus: totalSkus,
            groupCount: mixedGroups.length,
        };
    } catch (e) { /* ignore */ }

    try {
        var saved = await api.saveData(name, skusData, boxesData, groupsData, resultData);
        showToast('"' + saved.name + '" 已保存', 'success');
    } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
    }
}

// ── Auth UI ───────────────────────────────────────────

function updateAuthUI() {
    var pill = document.getElementById('authStatus');
    if (!pill) return;

    if (currentUser) {
        pill.innerHTML = '<div class="auth-pill">' +
            '<span>' + escapeHtml(currentUser.username) + '</span>' +
            '<button class="btn btn-sm" style="color:#fff;background:rgba(255,255,255,0.15);padding:2px 10px;border:none;border-radius:12px;cursor:pointer;font-size:12px;" onclick="handleLogout()">退出</button>' +
            '</div>';
    } else {
        pill.innerHTML = '<button class="btn btn-sm" style="background:rgba(255,255,255,0.2);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:8px;padding:6px 16px;font-size:13px;cursor:pointer;font-weight:500;" onclick="showAuthModal(\'login\')">登录 / 注册</button>';
    }

    // Toggle save/history buttons
    var saveBtn = document.getElementById('saveBtn');
    var historyBtn = document.getElementById('historyBtn');
    if (saveBtn) saveBtn.style.display = currentUser ? '' : 'none';
    if (historyBtn) historyBtn.style.display = currentUser ? '' : 'none';
}

// ── Escape HTML ───────────────────────────────────────

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Initialize ────────────────────────────────────────

function initAuth() {
    // Create toast container
    var toastDiv = document.createElement('div');
    toastDiv.id = 'toastContainer';
    toastDiv.className = 'toast-container';
    document.body.appendChild(toastDiv);

    // Create auth modal
    var authModal = document.createElement('div');
    authModal.id = 'authModal';
    authModal.className = 'modal-overlay';
    authModal.innerHTML =
        '<div class="modal-card">' +
        '<h3>账户</h3>' +
        '<div class="modal-tabs">' +
        '<div class="modal-tab active" id="authTabLogin" onclick="showAuthModal(\'login\')">登录</div>' +
        '<div class="modal-tab" id="authTabRegister" onclick="showAuthModal(\'register\')">注册</div>' +
        '</div>' +
        '<div class="modal-error"></div>' +
        '<div class="tab-content active" id="authFormLogin">' +
        '<div class="modal-form-group"><label>用户名</label><input type="text" id="loginUsername" placeholder="输入用户名" autocomplete="username"></div>' +
        '<div class="modal-form-group"><label>密码</label><input type="password" id="loginPassword" placeholder="输入密码" autocomplete="current-password"></div>' +
        '<div class="modal-actions">' +
        '<button class="btn btn-outline" onclick="hideAuthModal()">取消</button>' +
        '<button class="btn btn-primary" onclick="handleAuthSubmit()">登录</button>' +
        '</div>' +
        '</div>' +
        '<div class="tab-content" id="authFormRegister">' +
        '<div class="modal-form-group"><label>用户名</label><input type="text" id="registerUsername" placeholder="至少3个字符" autocomplete="username"></div>' +
        '<div class="modal-form-group"><label>密码</label><input type="password" id="registerPassword" placeholder="至少6个字符" autocomplete="new-password"></div>' +
        '<div class="modal-actions">' +
        '<button class="btn btn-outline" onclick="hideAuthModal()">取消</button>' +
        '<button class="btn btn-primary" onclick="handleAuthSubmit()">注册</button>' +
        '</div>' +
        '</div>' +
        '</div>';
    document.body.appendChild(authModal);

    // Click overlay to close
    authModal.addEventListener('click', function (e) {
        if (e.target === authModal) hideAuthModal();
    });

    // Enter key to submit in auth modal
    authModal.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') handleAuthSubmit();
    });

    // Create history modal
    var historyModal = document.createElement('div');
    historyModal.id = 'historyModal';
    historyModal.className = 'modal-overlay';
    historyModal.innerHTML =
        '<div class="modal-card" style="max-width:560px;">' +
        '<h3>历史记录</h3>' +
        '<div class="history-list" id="historyList"></div>' +
        '<div class="modal-actions" style="margin-top:16px;">' +
        '<button class="btn btn-outline" onclick="hideHistoryModal()">关闭</button>' +
        '</div>' +
        '</div>';
    document.body.appendChild(historyModal);

    historyModal.addEventListener('click', function (e) {
        if (e.target === historyModal) hideHistoryModal();
    });

    // Inject auth pill into header
    var headerRight = document.querySelector('.header > div:last-child');
    if (headerRight) {
        var authSpan = document.createElement('span');
        authSpan.id = 'authStatus';
        headerRight.insertBefore(authSpan, headerRight.firstChild);
    }

    // Inject history button into Step 1 button group
    var step1Btns = document.querySelectorAll('.section')[0].querySelector('.btn-group');
    if (step1Btns) {
        var historyBtn = document.createElement('button');
        historyBtn.id = 'historyBtn';
        historyBtn.className = 'btn btn-outline';
        historyBtn.textContent = '📂 选择历史记录';
        historyBtn.setAttribute('onclick', 'showHistoryModal()');
        historyBtn.style.display = 'none';
        step1Btns.appendChild(historyBtn);
    }

    // Inject save button into Step 4 button group
    var step4 = document.getElementById('resultsSection');
    if (step4) {
        var step4Btns = step4.querySelector('.btn-group');
        if (step4Btns) {
            var saveBtn = document.createElement('button');
            saveBtn.id = 'saveBtn';
            saveBtn.className = 'btn btn-primary';
            saveBtn.textContent = '💾 保存装箱数据';
            saveBtn.setAttribute('onclick', 'handleSave()');
            saveBtn.style.display = 'none';
            step4Btns.appendChild(saveBtn);
        }
    }

    // Restore session from stored token
    var token = api.getToken();
    if (token) {
        // Validate token by fetching history
        api.getHistory().then(function (items) {
            // Token is valid — decode username from payload (best-effort)
            try {
                var payload = JSON.parse(atob(token.split('.')[1]));
                currentUser = { id: parseInt(payload.sub), username: payload.username };
            } catch (e) {
                currentUser = { id: 0, username: '用户' };
            }
            updateAuthUI();
        }).catch(function () {
            api.clearToken();
            updateAuthUI();
        });
    } else {
        updateAuthUI();
    }
}

document.addEventListener('DOMContentLoaded', initAuth);
