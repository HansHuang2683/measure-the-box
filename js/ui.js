// ===== UI 控制器 =====

// ---- 数据存储 ----
let skus = [];
let boxTypes = [];
let mixedGroups = [];
let nextSkuId = 1;
let nextBoxId = 1;
let nextGroupId = 1;

// ---- 空腔吸附算法控制 ----
let _useCavityAlgorithm = false; // 默认关闭，使用原层架算法

// ---- 最后一次 3D 渲染的上下文（用于无 dropdown 选值时重渲染） ----
let _lastViewerContext = null; // { groupId, boxIdx }

// ---- 补货推荐状态 ----
let _lastReplenishmentPlan = null;
let _manualReplenishmentCandidates = [];
let _nextManualReplenishmentId = 1;

/**
 * 根据当前算法设置获取布局结果
 * 新算法返回 { status, productVolume, boxVolume, volumeUtilization, message, layers, cavities, diagnostics }
 * 旧算法返回 { status, productVolume, boxVolume, volumeUtilization, message, layers }
 */
function _getLayoutResult(group, boxType) {
    const boxInternal = boxType.internal;
    if (_useCavityAlgorithm && typeof generateMixedLayoutCavity === 'function') {
        try {
            return generateMixedLayoutCavity(group, skus, boxInternal);
        } catch (e) {
            console.error('空腔吸附算法异常:', e);
            // 降级到原始算法
            return generateMixedLayout(group, skus, boxInternal);
        }
    }
    return generateMixedLayout(group, skus, boxInternal);
}

function toggleCavityAlgorithm() {
    _useCavityAlgorithm = !_useCavityAlgorithm;
    const btn = document.getElementById('cavityToggle');
    if (btn) {
        btn.textContent = _useCavityAlgorithm ? '空腔吸附: ON' : '空腔吸附: OFF';
        btn.classList.toggle('cavity-active', _useCavityAlgorithm);
    }
    // 显示/隐藏"显示空腔"按钮
    const showBtn = document.getElementById('cavityShowToggle');
    if (showBtn) {
        showBtn.style.display = _useCavityAlgorithm ? '' : 'none';
        if (!_useCavityAlgorithm) {
            showBtn.textContent = '显示空腔: OFF';
            showBtn.classList.remove('cavity-active');
            // 关闭空腔显示
            if (typeof window.clearCavities === 'function') window.clearCavities();
        }
    }
    // 隐藏诊断面板
    const diag = document.getElementById('cavityDiagnostics');
    if (diag) diag.style.display = 'none';
    // 切换后刷新视图
    _refreshAfterToggle();
    return _useCavityAlgorithm;
}

/**
 * 算法切换后的刷新逻辑：优先用 dropdown 选值，无选值时用 last viewer context
 */
function _refreshAfterToggle() {
    const select = document.getElementById('viewerSelect');
    if (select?.value) {
        refreshViewer();
        return;
    }
    // 无 dropdown 选值，尝试用 last viewer context 直接重渲染
    if (!_lastViewerContext) {
        if (typeof showViewerEmpty === 'function') showViewerEmpty();
        return;
    }
    const group = mixedGroups.find(g => g.id === _lastViewerContext.groupId);
    const boxType = group ? boxTypes.find(b => b.id === group.boxTypeId) : null;
    if (!group || !boxType) {
        if (typeof showViewerEmpty === 'function') showViewerEmpty();
        return;
    }
    const result = _getLayoutResult(group, boxType);
    if (!result || (result.impossible && result.layers.length === 0)) {
        // 新算法失败，降级
        if (_useCavityAlgorithm) {
            _useCavityAlgorithm = false;
            const toggleBtn = document.getElementById('cavityToggle');
            if (toggleBtn) {
                toggleBtn.textContent = '空腔吸附: OFF';
                toggleBtn.classList.remove('cavity-active');
            }
            const showBtn = document.getElementById('cavityShowToggle');
            if (showBtn) showBtn.style.display = 'none';
            const oldResult = generateMixedLayout(group, skus, boxType.internal);
            if (oldResult && oldResult.layers && oldResult.layers.length > 0) {
                loadGroupIntoViewer(group, boxType, oldResult, _lastViewerContext.boxIdx);
                return;
            }
        }
        if (typeof showViewerEmpty === 'function') showViewerEmpty();
        return;
    }
    loadGroupIntoViewer(group, boxType, result, _lastViewerContext.boxIdx, result.cavities);
    if (_useCavityAlgorithm) _renderCavityDiagnostics(result);
}

function toggleCavityViewer() {
    if (typeof window.toggleCavityVisibility === 'function') {
        const visible = window.toggleCavityVisibility();
        const btn = document.getElementById('cavityShowToggle');
        if (btn) {
            btn.textContent = visible ? '显示空腔: ON' : '显示空腔: OFF';
            btn.classList.toggle('cavity-active', visible);
        }
    }
}

// ===== 补货推荐 =====

function getCurrentViewerGroupAndBox() {
    const select = document.getElementById('viewerSelect');
    const val = select?.value;
    if (!val) return null;
    const [groupId, boxIdx] = val.split('|');
    const group = mixedGroups.find(g => g.id === groupId);
    const boxType = group ? boxTypes.find(b => b.id === group.boxTypeId) : null;
    if (!group || !boxType) return null;
    return { group, boxType, boxIdx: parseInt(boxIdx) || 0 };
}

function toggleReplenishmentPanel() {
    const panel = document.getElementById('replenishmentPanel');
    if (!panel) return;
    const ctx = getCurrentViewerGroupAndBox();
    if (!ctx) {
        alert('请先选择一个箱子预览');
        return;
    }
    if (panel.style.display === 'none' || !panel.style.display) {
        panel.style.display = '';
        renderReplenishmentPanel();
    } else {
        panel.style.display = 'none';
        if (typeof window.clearReplenishmentOverlay === 'function') window.clearReplenishmentOverlay();
    }
}

function renderReplenishmentPanel(plan) {
    const panel = document.getElementById('replenishmentPanel');
    if (!panel) return;
    const ctx = getCurrentViewerGroupAndBox();
    if (!ctx) {
        panel.innerHTML = '<div class="replenishment-panel"><div class="replenishment-empty">请先选择一个箱子预览</div></div>';
        return;
    }

    const autoCandidates = typeof buildReplenishmentCandidates === 'function'
        ? buildReplenishmentCandidates(skus, mixedGroups, ctx.group, ctx.boxType)
        : [];
    const rowsHtml = _manualReplenishmentCandidates.map(c => _renderManualCandidateRow(c)).join('');
    const skuPickerHtml = _renderExistingSkuCandidatePicker(ctx);
    const resultHtml = plan ? _renderReplenishmentResult(plan) : '<div class="replenishment-empty">点击“重新计算”后生成每箱补货数量和预计利用率提升。</div>';

    panel.innerHTML = `
        <div class="replenishment-panel">
            <div class="replenishment-header">
                <div>
                    <div class="replenishment-title">剩余空间补货推荐</div>
                    <div class="replenishment-meta">${_escapeReplenishmentHtml(ctx.group.name)} | ${_escapeReplenishmentHtml(ctx.boxType.name)} | ${ctx.group.boxCount} 箱</div>
                </div>
                <div class="replenishment-actions">
                    <button class="btn btn-sm btn-primary" onclick="recalcReplenishment()">重新计算</button>
                    <button class="btn btn-sm btn-outline" onclick="previewReplenishmentInViewer()">显示推荐件预览</button>
                    <button class="btn btn-sm btn-outline" onclick="clearReplenishmentPreview()">清除预览</button>
                </div>
            </div>
            <div class="replenishment-source">
                自动候选：${autoCandidates.length} 个（软包、未分配 SKU、小硬盒彩盒）。可在下方手动添加客户准备订购的小彩盒。
            </div>
            <div class="replenishment-manual">
                <div class="replenishment-subtitle">手动候选小件</div>
                <div class="replenishment-picker">
                    ${skuPickerHtml}
                    <button class="btn btn-sm btn-outline" onclick="addCandidateFromExistingSku()">从已有 SKU 添加</button>
                    <button class="btn btn-sm btn-outline" onclick="addManualReplenishmentCandidate()">手动填写空白候选</button>
                </div>
                <div class="replenishment-table-wrap">
                    <table class="replenishment-candidate-table">
                        <thead>
                            <tr>
                                <th>名称</th><th>长</th><th>宽</th><th>高</th><th>包装</th><th>公差%</th><th>优先级</th><th>最多推荐</th><th></th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml || '<tr><td colspan="9" class="replenishment-muted">暂无手动候选</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
            <div class="replenishment-results">${resultHtml}</div>
        </div>
    `;
}

function recalcReplenishment() {
    updateDataFromTables();
    const ctx = getCurrentViewerGroupAndBox();
    if (!ctx) { alert('请先选择一个箱子预览'); return; }
    _syncManualReplenishmentCandidates();

    const autoCandidates = buildReplenishmentCandidates(skus, mixedGroups, ctx.group, ctx.boxType);
    const manualCandidates = _manualReplenishmentCandidates.map(_manualCandidateToReplenishment);
    const candidates = _mergeReplenishmentCandidates(autoCandidates, manualCandidates);
    if (candidates.length === 0) {
        _lastReplenishmentPlan = null;
        renderReplenishmentPanel({
            groupId: ctx.group.id,
            boxTypeId: ctx.boxType.id,
            boxCount: ctx.group.boxCount,
            currentUtilization: 0,
            projectedUtilization: 0,
            additions: [],
            cavitiesBefore: [],
            cavitiesAfter: [],
            unusableReasons: ['没有可用于补货推荐的候选小件'],
            overlayPlacements: [],
        });
        return;
    }

    try {
        _lastReplenishmentPlan = generateReplenishmentPlan(ctx.group, ctx.boxType, skus, candidates);
        renderReplenishmentPanel(_lastReplenishmentPlan);
    } catch (e) {
        console.error('补货推荐计算异常:', e);
        const panel = document.getElementById('replenishmentPanel');
        if (panel) {
            panel.innerHTML = '<div class="replenishment-panel"><div class="replenishment-error">补货推荐计算失败：' + _escapeReplenishmentHtml(e.message) + '</div></div>';
        }
    }
}

function previewReplenishmentInViewer() {
    const ctx = getCurrentViewerGroupAndBox();
    if (!ctx) { alert('请先选择一个箱子预览'); return; }
    if (!_lastReplenishmentPlan || _lastReplenishmentPlan.groupId !== ctx.group.id) {
        recalcReplenishment();
    }
    if (!_lastReplenishmentPlan || !_lastReplenishmentPlan.overlayPlacements || _lastReplenishmentPlan.overlayPlacements.length === 0) {
        alert('当前没有可预览的推荐件');
        return;
    }
    if (typeof window.renderReplenishmentOverlay === 'function') {
        window.renderReplenishmentOverlay(_lastReplenishmentPlan.overlayPlacements, _lastReplenishmentPlan.boxOrientation || ctx.boxType.internal);
    }
}

function clearReplenishmentPreview() {
    if (typeof window.clearReplenishmentOverlay === 'function') window.clearReplenishmentOverlay();
}

function addManualReplenishmentCandidate() {
    const ctx = getCurrentViewerGroupAndBox();
    const boxCount = ctx?.group?.boxCount || CONFIG.defaultMinBoxes;
    _syncManualReplenishmentCandidates();
    _manualReplenishmentCandidates.push({
        id: 'manual_repl_' + (_nextManualReplenishmentId++),
        name: '候选小彩盒',
        length: 10,
        width: 8,
        height: 3,
        packagingType: 'soft',
        softTolerance: 10,
        priority: 3,
        maxQty: boxCount * 30,
    });
    renderReplenishmentPanel(_lastReplenishmentPlan);
}

function addCandidateFromExistingSku() {
    const ctx = getCurrentViewerGroupAndBox();
    if (!ctx) { alert('请先选择一个箱子预览'); return; }
    _syncManualReplenishmentCandidates();

    const select = document.getElementById('existingSkuCandidateSelect');
    const skuId = select?.value;
    if (!skuId) {
        alert('请先选择一个已有 SKU');
        return;
    }
    const sku = skus.find(s => s.id === skuId);
    if (!sku || !sku.dimensions) return;

    const existing = _manualReplenishmentCandidates.find(c => c.sourceSkuId === sku.id);
    if (existing) {
        renderReplenishmentPanel(_lastReplenishmentPlan);
        return;
    }

    const boxCount = ctx.group.boxCount || CONFIG.defaultMinBoxes;
    _manualReplenishmentCandidates.push({
        id: 'manual_from_sku_' + sku.id + '_' + (_nextManualReplenishmentId++),
        sourceSkuId: sku.id,
        name: sku.name,
        length: sku.dimensions.length,
        width: sku.dimensions.width,
        height: sku.dimensions.height,
        packagingType: sku.packagingType || 'hard',
        softTolerance: sku.packagingType === 'soft' ? Math.round((sku.softTolerance || 0) * 100) : 0,
        priority: sku.packagingType === 'soft' ? 3 : 2,
        maxQty: boxCount * 30,
    });
    renderReplenishmentPanel(_lastReplenishmentPlan);
}

function removeManualReplenishmentCandidate(id) {
    _syncManualReplenishmentCandidates();
    _manualReplenishmentCandidates = _manualReplenishmentCandidates.filter(c => c.id !== id);
    renderReplenishmentPanel(_lastReplenishmentPlan);
}

function _syncManualReplenishmentCandidates() {
    const rows = document.querySelectorAll('#replenishmentPanel tr[data-candidate-id]');
    if (!rows.length) return;
    const next = [];
    rows.forEach(row => {
        const inputs = row.querySelectorAll('input, select');
        if (inputs.length < 8) return;
        const name = inputs[0].value.trim();
        const l = parseFloat(inputs[1].value);
        const w = parseFloat(inputs[2].value);
        const h = parseFloat(inputs[3].value);
        if (!name || !(l > 0) || !(w > 0) || !(h > 0)) return;
        next.push({
            id: row.getAttribute('data-candidate-id'),
            sourceSkuId: row.getAttribute('data-source-sku-id') || '',
            name,
            length: l,
            width: w,
            height: h,
            packagingType: inputs[4].value,
            softTolerance: Math.max(0, Math.min(20, parseFloat(inputs[5].value) || 0)),
            priority: Math.max(1, Math.min(5, parseInt(inputs[6].value) || 3)),
            maxQty: Math.max(0, parseInt(inputs[7].value) || 0),
        });
    });
    _manualReplenishmentCandidates = next;
}

function _manualCandidateToReplenishment(c) {
    return {
        id: c.id,
        skuId: c.sourceSkuId || c.id,
        name: c.name,
        dimensions: dims(c.length, c.width, c.height),
        packagingType: c.packagingType,
        softTolerance: c.packagingType === 'soft' ? c.softTolerance / 100 : 0,
        maxQty: c.maxQty,
        priority: c.priority,
        allowStackOnHard: c.packagingType === 'soft',
        source: c.sourceSkuId ? '已有SKU尺寸' : '手动候选',
    };
}

function _mergeReplenishmentCandidates(autoCandidates, manualCandidates) {
    const manualSkuIds = new Set(
        (manualCandidates || [])
            .map(c => c.skuId)
            .filter(id => id && !String(id).startsWith('manual_repl_'))
    );
    const filteredAuto = (autoCandidates || []).filter(c => !manualSkuIds.has(c.skuId));
    return [...filteredAuto, ...(manualCandidates || [])];
}

function _renderExistingSkuCandidatePicker(ctx) {
    const sorted = [...skus].sort((a, b) => dimsVolume(a.dimensions) - dimsVolume(b.dimensions));
    if (sorted.length === 0) {
        return '<select id="existingSkuCandidateSelect" disabled><option value="">暂无 SKU</option></select>';
    }
    const options = sorted.map(s => {
        const pkg = s.packagingType === 'soft' ? '软' : '硬';
        const tol = s.packagingType === 'soft' && s.softTolerance ? ', 公差' + Math.round(s.softTolerance * 100) + '%' : '';
        const label = `${s.name} (${formatDims(s.dimensions)} cm, ${pkg}${tol})`;
        return `<option value="${_escapeReplenishmentHtml(s.id)}">${_escapeReplenishmentHtml(label)}</option>`;
    }).join('');
    return `<select id="existingSkuCandidateSelect" class="replenishment-existing-select">${options}</select>`;
}

function _renderManualCandidateRow(c) {
    return `
        <tr data-candidate-id="${_escapeReplenishmentHtml(c.id)}" data-source-sku-id="${_escapeReplenishmentHtml(c.sourceSkuId || '')}">
            <td><input type="text" value="${_escapeReplenishmentHtml(c.name)}"></td>
            <td><input type="number" step="0.1" min="0.1" value="${c.length}"></td>
            <td><input type="number" step="0.1" min="0.1" value="${c.width}"></td>
            <td><input type="number" step="0.1" min="0.1" value="${c.height}"></td>
            <td>
                <select>
                    <option value="soft" ${c.packagingType === 'soft' ? 'selected' : ''}>软</option>
                    <option value="hard" ${c.packagingType === 'hard' ? 'selected' : ''}>硬</option>
                </select>
            </td>
            <td><input type="number" step="1" min="0" max="20" value="${c.softTolerance}"></td>
            <td><input type="number" step="1" min="1" max="5" value="${c.priority}"></td>
            <td><input type="number" step="1" min="0" value="${c.maxQty}"></td>
            <td><button class="btn btn-sm btn-danger" onclick="removeManualReplenishmentCandidate('${_escapeReplenishmentHtml(c.id)}')">删除</button></td>
        </tr>
    `;
}

function _renderReplenishmentResult(plan) {
    const current = _formatPercent(plan.currentUtilization);
    const projected = _formatPercent(plan.projectedUtilization);
    const gain = _formatPercent(Math.max(0, plan.projectedUtilization - plan.currentUtilization));
    let html = `
        <div class="replenishment-summary">
            <div><span>当前利用率</span><strong>${current}</strong></div>
            <div><span>推荐后</span><strong>${projected}</strong></div>
            <div><span>提升</span><strong>${gain}</strong></div>
            <div><span>真实空腔</span><strong>${(plan.cavitiesBefore || []).length} 个</strong></div>
        </div>
    `;

    if (!plan.additions || plan.additions.length === 0) {
        html += '<div class="replenishment-empty">未找到可安全放入的补货候选。可以手动添加更小尺寸的小彩盒后重算。</div>';
    } else {
        html += `
            <div class="replenishment-table-wrap">
                <table class="replenishment-result-table">
                    <thead>
                        <tr><th>推荐 SKU</th><th>包装</th><th>每箱建议</th><th>${plan.boxCount}箱合计</th><th>利用率贡献</th><th>摆放区域</th><th>提示</th></tr>
                    </thead>
                    <tbody>
                        ${plan.additions.map(a => `
                            <tr>
                                <td>${_escapeReplenishmentHtml(a.name)}</td>
                                <td>${a.packagingType === 'soft' ? '软包' : '硬盒彩盒'}</td>
                                <td><strong>${a.qtyPerBox}</strong> 个/箱</td>
                                <td><strong>${a.totalQty}</strong> 个</td>
                                <td>${_formatPercent(a.volumeContribution)}</td>
                                <td>${_escapeReplenishmentHtml(a.placementSummary)}</td>
                                <td>${(a.warnings || []).map(_escapeReplenishmentHtml).join('；') || '—'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    if (plan.unusableReasons && plan.unusableReasons.length > 0) {
        html += '<div class="replenishment-notes"><strong>剩余不可用空间：</strong>' +
            plan.unusableReasons.map(r => '<span>' + _escapeReplenishmentHtml(r) + '</span>').join('') +
            '</div>';
    }
    return html;
}

function _formatPercent(v) {
    if (!Number.isFinite(v)) return '0.0%';
    return (v * 100).toFixed(1) + '%';
}

function _escapeReplenishmentHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---- 初始化 ----
document.addEventListener('DOMContentLoaded', () => {
    addSkuRow();
    populateStdBoxSelect();
    // 默认添加所有 60cm(长)×50cm(宽) 以内的标准箱规
    for (const size of STANDARD_BOX_SIZES) {
        if (size[0] <= 60 && size[1] <= 50) {
            const name = `${size[0]}×${size[1]}×${size[2]}`;
            // 跳过已添加的（防止重复）
            if (boxTypes.some(b => b.name === name)) continue;
            const wall = CONFIG.defaultWallThickness;
            boxTypes.push({
                id: genBoxId(),
                name,
                external: dims(size[0], size[1], size[2]),
                wallThickness: wall,
                internal: dims(Math.max(0, size[0] - wall * 2), Math.max(0, size[1] - wall * 2), Math.max(0, size[2] - wall * 2)),
            });
        }
    }
    renderBoxChips();
    // 重新生成下拉菜单（过滤已添加的箱规）
    populateStdBoxSelect();
    renderGroups();
});

// ---- ID 生成 ----
function genSkuId() { return 'sku_' + (nextSkuId++); }
function genBoxId() { return 'box_' + (nextBoxId++); }
function genGroupId() { return 'grp_' + (nextGroupId++); }

// ===== 获取表单数据 =====

function getSkusFromTable() {
    const rows = document.querySelectorAll('#skuBody tr');
    const result = [];
    for (const row of rows) {
        const inputs = row.querySelectorAll('input, select');
        if (inputs.length < 7) continue;
        const name = inputs[0].value.trim();
        if (!name) continue;
        const l = parseFloat(inputs[1].value);
        const w = parseFloat(inputs[2].value);
        const h = parseFloat(inputs[3].value);
        const qty = parseInt(inputs[4].value) || 0;
        const pkgType = inputs[5].value;
        const tol = parseFloat(inputs[6].value) || 0;
        const id = row.dataset.skuId || genSkuId();
        row.dataset.skuId = id;
        if (l > 0 && w > 0 && h > 0 && qty > 0) {
            result.push({
                id, name, quantity: qty,
                dimensions: dims(l, w, h),
                packagingType: pkgType,
                softTolerance: pkgType === 'soft' ? (tol / 100) : 0,
            });
        }
    }
    return result;
}

function getBoxesFromTable() {
    return [...boxTypes];
}

function updateDataFromTables() {
    skus = getSkusFromTable();
    boxTypes = getBoxesFromTable();
    updateSkuEmpties();
    updateBoxEmpties();
}

// ---- 空状态显示 ----

function updateSkuEmpties() {
    const empty = document.getElementById('skuEmpty');
    const rows = document.querySelectorAll('#skuBody tr').length;
    empty.style.display = rows === 0 ? 'block' : 'none';
}

// ===== SKU 管理 =====

function addSkuRow(data) {
    const tbody = document.getElementById('skuBody');
    const empty = document.getElementById('skuEmpty');
    empty.style.display = 'none';

    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" placeholder="例如: BR-ICE-DRAGON-FBA" value="${data?.name || ''}"></td>
        <td><input type="number" step="0.1" min="0.1" placeholder="长" value="${data?.length || ''}"></td>
        <td><input type="number" step="0.1" min="0.1" placeholder="宽" value="${data?.width || ''}"></td>
        <td><input type="number" step="0.1" min="0.1" placeholder="高" value="${data?.height || ''}"></td>
        <td><input type="number" min="1" placeholder="数量" value="${data?.qty || ''}"></td>
        <td>
            <select>
                <option value="hard" ${data?.pkg === 'soft' ? '' : 'selected'}>硬</option>
                <option value="soft" ${data?.pkg === 'soft' ? 'selected' : ''}>软</option>
            </select>
        </td>
        <td><input type="number" step="1" min="0" max="20" placeholder="0" value="${data?.tol || ''}"></td>
        <td style="white-space:nowrap;">
            <button class="btn btn-sm btn-outline" onclick="duplicateSkuRow(this)" title="复制此行">📋</button>
            <button class="btn btn-sm btn-danger" onclick="deleteSkuRow(this)">删除</button>
        </td>
    `;
    tbody.appendChild(tr);
}

function duplicateSkuRow(btn) {
    const tr = btn.closest('tr');
    const inputs = tr.querySelectorAll('input, select');
    if (inputs.length < 7) return;
    const data = {
        name: inputs[0].value,
        length: inputs[1].value,
        width: inputs[2].value,
        height: inputs[3].value,
        qty: inputs[4].value,
        pkg: inputs[5].value,
        tol: inputs[6].value,
    };
    addSkuRow(data);
}

function deleteSkuRow(btn) {
    const tr = btn.closest('tr');
    tr.remove();
    updateSkuEmpties();
}

// ===== 箱子类型管理（芯片式） =====

function addBoxRow(data) {
    const id = genBoxId();
    const wall = data?.wall ?? CONFIG.defaultWallThickness;
    const l = parseFloat(data?.length) || 0;
    const w = parseFloat(data?.width) || 0;
    const h = parseFloat(data?.height) || 0;
    if (!(l > 0 && w > 0 && h > 0)) return null;

    const box = {
        id,
        name: data?.name || `${l}×${w}×${h}`,
        external: dims(l, w, h),
        wallThickness: wall,
        internal: dims(Math.max(0, l - wall * 2), Math.max(0, w - wall * 2), Math.max(0, h - wall * 2)),
    };
    boxTypes.push(box);
    renderBoxChips();
    populateStdBoxSelect();
    return box;
}

function deleteBoxRow(boxId) {
    boxTypes = boxTypes.filter(b => b.id !== boxId);
    renderBoxChips();
    populateStdBoxSelect();
}

function duplicateBoxRow(boxId) {
    const src = boxTypes.find(b => b.id === boxId);
    if (src) addBoxRow({ name: src.name + ' (复制)', length: String(src.external.length), width: String(src.external.width), height: String(src.external.height), wall: src.wallThickness });
}

function renderBoxChips() {
    const container = document.getElementById('boxTypeChips');
    if (!container) return;
    if (boxTypes.length === 0) {
        container.innerHTML = '';
        document.getElementById('boxEmpty').style.display = 'block';
        return;
    }
    container.innerHTML = boxTypes.map(bt => `
        <div class="box-chip" title="外${formatDims(bt.external)} 壁厚${bt.wallThickness}cm 内${formatDims(bt.internal)}">
            <span class="box-chip-name">${bt.name}</span>
            <span class="box-chip-dims">内${formatDims(bt.internal)}</span>
            <button class="btn btn-sm btn-outline" onclick="duplicateBoxRow('${bt.id}')" title="复制" style="min-width:24px;padding:0 4px;font-size:11px;">📋</button>
            <button class="btn btn-sm btn-danger" onclick="deleteBoxRow('${bt.id}')" title="删除">×</button>
        </div>
    `).join('');
    document.getElementById('boxEmpty').style.display = 'none';
}

function updateBoxEmpties() {
    const empty = document.getElementById('boxEmpty');
    if (empty) empty.style.display = boxTypes.length === 0 ? 'block' : 'none';
}

function populateStdBoxSelect() {
    const select = document.getElementById('stdBoxSelect');
    if (!select) return;
    select.innerHTML = '<option value="">-- 选择标准箱规快速添加 --</option>';
    const sorted = [...STANDARD_BOX_SIZES].sort((a, b) => (a[0]*a[1]*a[2]) - (b[0]*b[1]*b[2]));
    for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        const name = `${s[0]}×${s[1]}×${s[2]}`;
        // 已添加的箱规不出现在下拉菜单中
        if (boxTypes.some(b => b.name === name)) continue;
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `${name}cm → 内${(s[0]-2).toFixed(0)}×${(s[1]-2).toFixed(0)}×${(s[2]-2).toFixed(0)}`;
        select.appendChild(opt);
    }
    // 缓存排序后的数组（避免全局污染）
    select._sortedStdSizes = sorted;
}

function addSelectedStdBox() {
    const select = document.getElementById('stdBoxSelect');
    if (!select) return;
    const idx = parseInt(select.value);
    if (isNaN(idx)) return;
    const sorted = select._sortedStdSizes || STANDARD_BOX_SIZES;
    const size = sorted[idx];
    if (!size) return;
    const name = `${size[0]}×${size[1]}×${size[2]}`;
    if (boxTypes.some(b => b.name === name)) {
        select.value = '';
        return;
    }
    addBoxRow({ name, length: String(size[0]), width: String(size[1]), height: String(size[2]), wall: CONFIG.defaultWallThickness });
    select.value = '';
}

function addAllStdBoxes() {
    const added = [];
    for (const size of STANDARD_BOX_SIZES) {
        const name = `${size[0]}×${size[1]}×${size[2]}`;
        if (boxTypes.some(b => b.name === name)) continue;
        addBoxRow({ name, length: String(size[0]), width: String(size[1]), height: String(size[2]), wall: CONFIG.defaultWallThickness });
        added.push(name);
    }
    if (added.length === 0) {
        alert('所有标准箱型已添加');
    } else {
        populateStdBoxSelect();
    }
}

function addCustomBox() {
    const l = parseFloat(document.getElementById('custBoxL')?.value);
    const w = parseFloat(document.getElementById('custBoxW')?.value);
    const h = parseFloat(document.getElementById('custBoxH')?.value);
    const wall = parseFloat(document.getElementById('custBoxWall')?.value) || CONFIG.defaultWallThickness;
    if (!(l > 0 && w > 0 && h > 0)) {
        alert('请输入有效的长宽高尺寸');
        return;
    }
    addBoxRow({ name: `自定义 ${l}×${w}×${h}`, length: String(l), width: String(w), height: String(h), wall });
    document.getElementById('custBoxL').value = '';
    document.getElementById('custBoxW').value = '';
    document.getElementById('custBoxH').value = '';
    document.getElementById('custBoxWall').value = '1.0';
}

// ===== 混装组管理 =====

function addMixedGroup(prefill) {
    updateDataFromTables();
    const group = {
        id: genGroupId(),
        name: prefill?.name || `混装组 ${mixedGroups.length + 1}`,
        boxTypeId: prefill?.boxTypeId || (boxTypes.length > 0 ? boxTypes[0].id : ''),
        boxCount: prefill?.boxCount || CONFIG.defaultMinBoxes,
        assignments: prefill?.assignments || [],
    };
    mixedGroups.push(group);
    renderGroups();
    updateGroupEmpty();
}

function deleteGroup(groupId) {
    mixedGroups = mixedGroups.filter(g => g.id !== groupId);
    renderGroups();
    updateGroupEmpty();
}

function updateGroupEmpty() {
    document.getElementById('groupEmpty').style.display = mixedGroups.length === 0 ? 'block' : 'none';
}

function renderGroups() {
    updateDataFromTables();
    const container = document.getElementById('groupsContainer');
    container.innerHTML = '';

    for (const group of mixedGroups) {
        const boxType = boxTypes.find(b => b.id === group.boxTypeId);
        const boxName = boxType ? `${boxType.name} (${formatDims(boxType.external)})` : '未选择箱型';
        const internalStr = boxType ? formatDims(boxType.internal) : '—';

        // 验证
        const result = boxType ? validateMixedGroup(group, skus, boxType.internal) : null;

        // 剩余产品
        const remainder = calcGroupRemainder(group, skus);
        const totalSkuQty = group.assignments.reduce((s, a) => {
            const sku = skus.find(sk => sk.id === a.skuId);
            return s + (sku ? sku.quantity : 0);
        }, 0);

        const card = document.createElement('div');
        card.className = 'card';
        card.setAttribute('data-group-id', group.id);
        card.innerHTML = `
            <div class="card-header">
                <span class="card-title">📦 ${group.name}</span>
                <div style="display:flex;gap:6px;">
                    <button class="btn btn-sm btn-outline" onclick="editGroup('${group.id}')">编辑</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteGroup('${group.id}')">删除</button>
                </div>
            </div>
            <div class="form-row" style="margin-bottom:12px;">
                <div class="form-group">
                    <label>箱型</label>
                    <select onchange="updateGroupBoxType('${group.id}', this.value)">
                        ${boxTypes.map(bt =>
                            `<option value="${bt.id}" ${bt.id === group.boxTypeId ? 'selected' : ''}>${bt.name} (${formatDims(bt.external)})</option>`
                        ).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>箱数</label>
                    <input type="number" min="1" value="${group.boxCount}" onchange="updateGroupBoxCount('${group.id}', this.value)">
                    <span class="form-hint">${group.boxCount < 5 ? '⚠️ 少于5箱不免配置费' : '✅ ≥5箱免配置费'}</span>
                </div>
                <div class="form-group">
                    <label>箱内径</label>
                    <div style="padding:8px 0;font-size:13px;color:#666;">${internalStr}</div>
                </div>
            </div>
            <table class="group-sku-table">
                <thead><tr>
                    <th>SKU</th>
                    <th>包装</th>
                    <th>公差</th>
                    <th>尺寸 (cm)</th>
                    <th style="width:100px;">每箱数量</th>
                    <th>总计</th>
                    <th>剩余</th>
                    <th></th>
                </tr></thead>
                <tbody>
                    ${group.assignments.map((asgn, idx) => {
                        const sku = skus.find(s => s.id === asgn.skuId);
                        if (!sku) return '';
                        const used = asgn.qtyPerBox * group.boxCount;
                        const rem = Math.max(0, sku.quantity - used);
                        return `<tr>
                            <td><strong>${sku.name}</strong></td>
                            <td>${sku.packagingType === 'soft' ? '软' : '硬'}</td>
                            <td>${sku.packagingType === 'soft' ? (sku.softTolerance * 100).toFixed(0) + '%' : '—'}</td>
                            <td>${formatDims(sku.dimensions)}</td>
                            <td><input type="number" min="0" class="qty-input" value="${asgn.qtyPerBox}" onchange="updateAssignmentQty('${group.id}', ${idx}, this.value)"></td>
                            <td>${used}</td>
                            <td>${rem > 0 ? rem : '—'}</td>
                            <td><button class="btn btn-sm btn-danger" onclick="removeAssignment('${group.id}', ${idx})">×</button></td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
            <div style="margin-top:8px;">
                <select class="add-sku-select" style="padding:6px 10px;border:1px solid #ddd;border-radius:4px;">
                    <option value="">-- 添加 SKU 到混装组 --</option>
                    ${skus.filter(s => !group.assignments.find(a => a.skuId === s.id)).map(s =>
                        `<option value="${s.id}">${s.name} (剩余: ${calcSkuRemaining(s, group)})</option>`
                    ).join('')}
                </select>
                <button class="btn btn-sm btn-primary" onclick="addSkuToGroup('${group.id}')">+ 添加</button>
            </div>
            ${result ? `
                <div class="result-banner ${result.verifiedFit ? 'result-verified' : result.estimatedFit ? 'result-estimated' : 'result-impossible'}">
                    ${result.verifiedFit ? '✅' : result.estimatedFit ? '⚠️' : '❌'}
                    ${result.verifiedFit ? '验证通过' : result.estimatedFit ? '估算通过' : '无法装下'}
                    — ${result.message}
                    ${!result.impossible ? ` | 利用率 ${(result.volumeUtilization * 100).toFixed(1)}%` : ''}
                    <button class="btn btn-sm btn-outline" style="margin-left:8px;" onclick="viewGroup3D('${group.id}')">3D 查看</button>
                </div>
            ` : ''}
            ${remainder > 0 ? `
                <div style="margin-top:8px;font-size:13px;color:#e37400;">
                    📌 剩余 ${remainder} 件 (${(remainder / totalSkuQty * 100).toFixed(0)}%) 未装箱
                    ${shouldSuggestCustom(remainder, group.assignments.reduce((s, a) => {
                        const sku = skus.find(sk => sk.id === a.skuId);
                        return s + (sku ? sku.quantity : 0);
                    }, 0), 10) ? '<button class="btn btn-sm btn-outline" style="margin-left:8px;" onclick="showCustomSuggestion()">查看定制箱建议</button>' : ''}
                </div>
            ` : ''}
        `;
        container.appendChild(card);
    }
    updateGroupEmpty();
    updateResults();
}

function calcSkuRemaining(sku, group) {
    const asgn = group.assignments.find(a => a.skuId === sku.id);
    if (!asgn) return sku.quantity;
    return Math.max(0, sku.quantity - asgn.qtyPerBox * group.boxCount);
}

// ---- 混装组操作 ----

function updateGroupBoxType(groupId, boxTypeId) {
    const group = mixedGroups.find(g => g.id === groupId);
    if (group) { group.boxTypeId = boxTypeId; renderGroups(); _autoRefreshViewer(groupId); }
}

function updateGroupBoxCount(groupId, val) {
    const group = mixedGroups.find(g => g.id === groupId);
    if (group) { group.boxCount = parseInt(val) || CONFIG.defaultMinBoxes; renderGroups(); _autoRefreshViewer(groupId); }
}

function updateAssignmentQty(groupId, idx, val) {
    const group = mixedGroups.find(g => g.id === groupId);
    if (group && group.assignments[idx]) {
        group.assignments[idx].qtyPerBox = Math.max(0, parseInt(val) || 0);
        renderGroups();
        _autoRefreshViewer(groupId);
    }
}

/** 如果3D查看器正在显示该组，自动刷新 */
function _autoRefreshViewer(groupId) {
    if (!_lastViewerContext || _lastViewerContext.groupId !== groupId) return;
    const select = document.getElementById('viewerSelect');
    if (!select) return;
    const optVal = groupId + '|' + _lastViewerContext.boxIdx;
    const opt = select.querySelector('option[value="' + optVal + '"]');
    if (!opt) return;
    select.value = optVal;
    refreshViewer();
}

function removeAssignment(groupId, idx) {
    const group = mixedGroups.find(g => g.id === groupId);
    if (group) {
        group.assignments.splice(idx, 1);
        renderGroups();
    }
}

function addSkuToGroup(groupId) {
    const group = mixedGroups.find(g => g.id === groupId);
    if (!group) return;
    const card = document.querySelector(`#groupsContainer .card[data-group-id="${groupId}"]`);
    if (!card) return;
    const select = card.querySelector('.add-sku-select');
    if (!select || !select.value) return;
    const skuId = select.value;
    if (group.assignments.find(a => a.skuId === skuId)) return;
    group.assignments.push({ skuId, qtyPerBox: 1 });
    renderGroups();
}

function editGroup(groupId) {
    // Simple inline editing is already handled by the card UI
    // Scroll to the group card
    const cards = document.querySelectorAll('#groupsContainer .card');
    for (const card of cards) {
        if (card.querySelector(`[onclick*="'${groupId}'"]`)) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.style.border = '2px solid #1a73e8';
            setTimeout(() => card.style.border = '', 2000);
            break;
        }
    }
}

// ===== 验证和结果 =====

function validateAll() {
    // 先从卡片中同步未提交的输入（用户可能改完数量直接点验证，onchange 尚未触发）
    syncGroupInputs();
    updateDataFromTables();
    if (skus.length === 0) { alert('请先添加 SKU'); return; }
    if (boxTypes.length === 0) { alert('请先添加箱子类型'); return; }
    if (mixedGroups.length === 0) { alert('请先创建混装组'); return; }
    renderGroups();
    document.getElementById('resultsSection').style.display = 'block';
    document.getElementById('resultsSection').scrollIntoView({ behavior: 'smooth' });
    updateViewerSelect();
}

function syncGroupInputs() {
    const cards = document.querySelectorAll('#groupsContainer .card');
    for (const card of cards) {
        const groupId = card.getAttribute('data-group-id');
        const group = mixedGroups.find(g => g.id === groupId);
        if (!group) continue;
        // 读取箱数
        const inputs = card.querySelectorAll('.form-group input[type="number"]');
        if (inputs.length > 0) {
            const val = parseInt(inputs[0].value);
            if (val > 0) group.boxCount = val;
        }
        // 读取每箱数量
        const qtyInputs = card.querySelectorAll('.qty-input');
        qtyInputs.forEach((input, idx) => {
            if (group.assignments[idx]) {
                group.assignments[idx].qtyPerBox = Math.max(0, parseInt(input.value) || 0);
            }
        });
    }
}

function updateResults() {
    const section = document.getElementById('resultsSection');
    if (mixedGroups.length === 0) { section.style.display = 'none'; return; }

    section.style.display = 'block';

    const totalSkus = skus.reduce((s, sku) => s + sku.quantity, 0);
    let totalAllocated = 0;
    let totalBoxes = 0;
    let totalRemainder = 0;

    for (const group of mixedGroups) {
        totalBoxes += group.boxCount;
        const rem = calcGroupRemainder(group, skus);
        totalRemainder += rem;
        for (const asgn of group.assignments) {
            totalAllocated += asgn.qtyPerBox * group.boxCount;
        }
    }

    // Summary
    document.getElementById('resultsSummary').innerHTML = `
        <div class="summary-item"><div class="summary-value">${totalBoxes}</div><div class="summary-label">总箱数</div></div>
        <div class="summary-item"><div class="summary-value">${totalAllocated}/${totalSkus}</div><div class="summary-label">已分配</div></div>
        <div class="summary-item"><div class="summary-value">${totalRemainder}</div><div class="summary-label">剩余</div></div>
        <div class="summary-item"><div class="summary-value">${mixedGroups.length}</div><div class="summary-label">混装组</div></div>
        <div class="summary-item">
            <div class="summary-value" style="color:${totalBoxes >= 5 ? '#34a853' : '#ea4335'}">
                ${totalBoxes >= 5 ? '✅ 达标' : '⚠️ 不足'}
            </div>
            <div class="summary-label">${totalBoxes >= 5 ? '≥5箱免配置费' : '少于5箱将产生配置费'}</div>
        </div>
    `;

    // Custom suggestion — 全量产品定制箱优化方案
    const suggestionDiv = document.getElementById('customBoxSuggestion');
    if (skus.length > 0) {
        try {
            const plan = generateCustomBoxPlan(skus);
            suggestionDiv.innerHTML = _renderFullCustomBoxPlan(plan);
        } catch (e) {
            console.error('定制箱方案生成失败:', e);
            suggestionDiv.innerHTML = '<div style="color:#c62828;padding:8px;font-size:13px;">定制箱方案生成失败，请检查 SKU 数据</div>';
        }
    } else {
        suggestionDiv.innerHTML = '';
    }

    updateViewerSelect();
}

/**
 * 渲染全量产品定制箱优化方案
 */
function _renderFullCustomBoxPlan(plan) {
    if (!plan || !plan.boxTypes || plan.boxTypes.length === 0) return '';
    const bt = plan.boxTypes;
    const summary = plan.summary;

    let html = `<div style="margin-top:16px;">
        <div class="section-title">\u{1F4E6} 全量产品定制箱优化方案</div>
        <div style="font-size:13px;color:#666;margin-bottom:12px;line-height:1.6;">
            本方案不使用已有箱型，基于所有 SKU 的产品尺寸、总数量和包装属性，重新反推定制箱尺寸、箱数和混装方式。
            ${summary.hasTailBox ? '存在尾箱，建议结合实际装箱情况调整。' : ''}
        </div>`;

    // 汇总表
    html += _renderAllBoxSummary(bt);

    // 各箱型详情
    for (const box of bt) {
        html += _renderBoxTypeCard(box);
    }

    html += '</div>';
    return html;
}

/**
 * 全量定制箱汇总表
 */
function _renderAllBoxSummary(boxTypes) {
    let rows = '';
    for (const box of boxTypes) {
        const ext = box.externalDims || {};
        const mixInfo = box.mixSkus && box.mixSkus.length > 0
            ? box.mixSkus.map(m => m.skuName + '(' + m.qtyPerBox + ')').join(', ')
            : '无';
        const perBoxStr = box.perBoxStructure
            ? box.perBoxStructure.map(s => s.skuName + '×' + s.qty).join('+')
            : box.mainSku + '×' + box.perBoxCount;

        const boxCountStr = (box.boxCount || 0) < 5
            ? '<span style="color:#c5221f;font-weight:600;">' + (box.boxCount || 0) + ' ⚠️</span>'
            : String(box.boxCount || 0);

        rows += '<tr><td>定制箱 ' + (box.boxId || '') + '</td>' +
            '<td>' + (box.positioning || '—') + '</td>' +
            '<td>' + formatDims(ext) + '</td>' +
            '<td style="font-size:12px;">' + (box.mainSku || '—') + '</td>' +
            '<td style="font-size:12px;">' + mixInfo + '</td>' +
            '<td style="font-size:12px;">' + perBoxStr + '</td>' +
            '<td>' + boxCountStr + '</td>' +
            '<td>' + (box.hasTail ? '是' : '否') + '</td>' +
            '<td class="' + (box.maxSideOk ? 'text-success' : 'text-danger') + '">' + (box.maxSideOk ? '是' : '否') + '</td>' +
            '<td style="font-size:12px;">' + (box.softSpaceNote || (box.type === 'single_hard' ? '单SKU专用' : '—')) + '</td></tr>';
    }
    return '<table class="custom-box-summary-table" style="margin-bottom:16px;"><thead><tr>' +
        '<th>定制箱型</th><th>箱型定位</th><th>推荐外箱尺寸</th>' +
        '<th>主SKU</th><th>辅助/混装SKU</th><th>每箱装入结构</th>' +
        '<th>预计箱数</th><th>是否有尾箱</th><th>≤60cm</th><th>说明</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
}

/**
 * 渲染单个箱型详情卡片
 */
function _renderBoxTypeCard(box) {
    const ext = box.externalDims || {};
    const intN = box.internalNeeds || {};
    const isHardMixed = box.type === 'hard_mixed';
    const isSoft = box.type === 'soft_mixed';
    const cardClass = isHardMixed ? 'custom-box-hard' : isSoft ? 'custom-box-soft' : 'custom-box-hard';

    const rationaleHtml = (box.designRationale || []).map(function(l) { return '<div>• ' + l + '</div>'; }).join('');
    const volOptHtml = (box.volumeOptimization || []).map(function(l) { return '<div>• ' + l + '</div>'; }).join('');
    const riskHtml = (box.riskTips || []).map(function(t) { return '<div>⚠️ ' + t + '</div>'; }).join('');

    const perBoxHtml = (box.perBoxStructure || [])
        .map(function(s) { return s.skuName + ' × ' + s.qty; }).join(' + ');

    const mixHtml = (box.mixSkus || []).length > 0
        ? box.mixSkus.map(function(m) { return m.skuName + ' × ' + m.qtyPerBox; }).join('、')
        : '无';

    const tailHtml = box.hasTail
        ? '有尾箱（' + box.tailQty + '个），可考虑与软包装混装'
        : '无尾箱，全部为标准箱';

    // 箱数不足5箱时的警告
    const boxCountWarn = box.boxCount < 5
        ? '<div style="background:#fce8e6;color:#c5221f;padding:8px 16px;font-size:13px;border-bottom:1px solid #f5c6c2;">⚠️ 仅 ' + box.boxCount + ' 箱，不足5箱将产生入库配置费。建议增大每箱数量或合并到其他箱型</div>'
        : '';

    return '<div class="custom-box-card ' + cardClass + '" style="margin-bottom:16px;">' +
        '<div class="custom-box-title">定制箱' + (box.boxId || '') + '：' + (box.mainSku || '定制箱') + (box.positioning ? ' — ' + box.positioning : '') + '</div>' +
        boxCountWarn +
        '<div class="custom-box-body">' +
        '<table class="custom-box-detail-table">' +
        '<tr><td>箱型定位</td><td>' + (box.positioning || '—') + '</td></tr>' +
        '<tr><td>推荐外箱尺寸</td><td>约 ' + formatDims(ext) + ' cm</td></tr>' +
        '<tr><td>理论内径需求</td><td>' + formatDims(intN) + ' cm</td></tr>' +
        '<tr><td>主SKU</td><td>' + (box.mainSku || '—') + '</td></tr>' +
        '<tr><td>辅助/混装SKU</td><td>' + mixHtml + '</td></tr>' +
        '<tr><td>每箱装入结构</td><td>' + (perBoxHtml || '—') + '</td></tr>' +
        '<tr><td>预计箱数</td><td>' + (box.boxCount || 0) + ' 箱</td></tr>' +
        '<tr><td>是否存在尾箱</td><td>' + tailHtml + '</td></tr>' +
        '<tr><td>摆放方向</td><td>' + (box.orientationLabel || '—') + '</td></tr>' +
        '<tr><td>是否 ≤ 60cm</td><td class="' + (box.maxSideOk ? 'text-success' : 'text-danger') + '">' + (box.maxSideOk ? '满足，最长边约 ' + box.maxSideValue + 'cm' : '超出！最长边约 ' + box.maxSideValue + 'cm') + '</td></tr>' +
        '</table>' +
        (rationaleHtml ? '<div class="custom-box-section" style="margin-top:10px;">为什么这样设计</div><div style="font-size:13px;color:#555;line-height:1.7;">' + rationaleHtml + '</div>' : '') +
        (volOptHtml ? '<div class="custom-box-section" style="margin-top:10px;">体积优化逻辑</div><div style="font-size:13px;color:#555;line-height:1.7;">' + volOptHtml + '</div>' : '') +
        (riskHtml ? '<div class="custom-box-section" style="margin-top:10px;">风险提示</div><div style="font-size:13px;color:#c62828;line-height:1.7;">' + riskHtml + '</div>' : '') +
        '</div></div>';
}

function showCustomSuggestion() {
    document.getElementById('resultsSection').scrollIntoView({ behavior: 'smooth' });
}

// ===== 3D 查看 =====

function viewGroup3D(groupId) {
    const group = mixedGroups.find(g => g.id === groupId);
    if (!group) return;
    const boxType = boxTypes.find(b => b.id === group.boxTypeId);
    if (!boxType) return;

    const result = _getLayoutResult(group, boxType);
    if (result.impossible && result.layers.length === 0) {
        alert('此混装组无法装下，无法生成 3D 预览');
        return;
    }

    // 更新 dropdown 选值，使刷新/切换算法能继续渲染同一箱子
    const select = document.getElementById('viewerSelect');
    if (select) {
        const optVal = group.id + '|0';
        const exists = select.querySelector('option[value="' + optVal + '"]');
        if (exists) select.value = optVal;
    }

    _lastViewerContext = { groupId: group.id, boxIdx: 0 };
    loadGroupIntoViewer(group, boxType, result, 0, result.cavities);
    document.getElementById('resultsSection').scrollIntoView({ behavior: 'smooth' });
}

function updateViewerSelect() {
    const select = document.getElementById('viewerSelect');
    if (!select) return;
    select.innerHTML = '<option value="">-- 选择一个箱子预览 --</option>';

    for (const group of mixedGroups) {
        const boxType = boxTypes.find(b => b.id === group.boxTypeId);
        if (!boxType) continue;
        const result = _getLayoutResult(group, boxType);
        if (result.impossible && result.layers.length === 0) continue;

        for (let i = 0; i < Math.min(group.boxCount, 5); i++) {
            const opt = document.createElement('option');
            opt.value = `${group.id}|${i}`;
            const badge = result.verifiedFit ? '✅' : '⚠️';
            const placed = result.layers.reduce((s, l) => s + l.itemCount, 0);
            const total = group.assignments.reduce((s, a) => s + a.qtyPerBox, 0);
            const algoTag = _useCavityAlgorithm ? ' [空腔]' : '';
            opt.textContent = `${badge} ${group.name} — 箱 #${i + 1} (${placed}/${total}件)${algoTag}`;
            select.appendChild(opt);
        }
    }
}

function refreshViewer() {
    try {
        // 退出沙盘模式再刷新，避免状态残留导致3D场景崩溃
        if (typeof exitSandboxMode === 'function') exitSandboxMode();

        const select = document.getElementById('viewerSelect');
        const val = select?.value;
        if (!val) {
            if (typeof showViewerEmpty === 'function') showViewerEmpty();
            else {
                const c = document.getElementById('viewer-container');
                if (c) c.innerHTML = '<div class="viewer-empty">选择上方下拉菜单中的箱子查看 3D 布局</div>';
            }
            _resetReplenishmentPanelForViewer();
            return;
        }

        const [groupId, boxIdx] = val.split('|');
        const group = mixedGroups.find(g => g.id === groupId);
        const boxType = boxTypes.find(b => b.id === group.boxTypeId);
        if (!group || !boxType) return;

        // 用空腔算法获取布局
        let result;
        try {
            result = _getLayoutResult(group, boxType);
        } catch (e) {
            console.error('_getLayoutResult 异常:', e);
            // 显示错误但不崩溃
            const c = document.getElementById('viewer-container');
            if (c) c.innerHTML = '<div class="viewer-empty" style="color:#c62828;">算法异常: ' + e.message + '</div>';
            return;
        }

        if (!result || (result.impossible && result.layers.length === 0)) {
            // 如果算法失败，自动降级到原始算法
            if (_useCavityAlgorithm) {
                console.warn('空腔吸附算法失败，降级到原始层架算法');
                _useCavityAlgorithm = false;
                const toggleBtn = document.getElementById('cavityToggle');
                if (toggleBtn) {
                    toggleBtn.textContent = '空腔吸附: OFF';
                    toggleBtn.classList.remove('cavity-active');
                }
                const showBtn = document.getElementById('cavityShowToggle');
                if (showBtn) showBtn.style.display = 'none';
                const oldResult = generateMixedLayout(group, skus, boxType.internal);
                if (oldResult && oldResult.layers && oldResult.layers.length > 0) {
                    loadGroupIntoViewer(group, boxType, oldResult, parseInt(boxIdx));
                    _lastViewerContext = { groupId: group.id, boxIdx: parseInt(boxIdx) };
                    return;
                }
            }
            // 无可用布局
            const c = document.getElementById('viewer-container');
            if (c) c.innerHTML = '<div class="viewer-empty">此箱子组合无可用布局</div>';
            return;
        }

        loadGroupIntoViewer(group, boxType, result, parseInt(boxIdx), result.cavities);
        _lastViewerContext = { groupId: group.id, boxIdx: parseInt(boxIdx) };
        _resetReplenishmentPanelForViewer();
        if (_useCavityAlgorithm) {
            _renderCavityDiagnostics(result);
        }
    } catch (e) {
        console.error('refreshViewer 异常:', e);
        const c = document.getElementById('viewer-container');
        if (c) c.innerHTML = '<div class="viewer-empty" style="color:#c62828;">刷新异常: ' + e.message + '</div>';
    }
}

function _resetReplenishmentPanelForViewer() {
    _lastReplenishmentPlan = null;
    if (typeof window.clearReplenishmentOverlay === 'function') window.clearReplenishmentOverlay();
    const panel = document.getElementById('replenishmentPanel');
    if (panel && panel.style.display !== 'none' && panel.innerHTML.trim()) {
        renderReplenishmentPanel();
    }
}

function _renderCavityDiagnostics(result) {
    const diagDiv = document.getElementById('cavityDiagnostics');
    if (!diagDiv) return;

    if (!_useCavityAlgorithm || !result.diagnostics) {
        diagDiv.style.display = 'none';
        return;
    }

    const d = result.diagnostics;
    const cavities = result.cavities;
    const diag = d;

    let html = '<div class="cavity-diag-panel">';
    html += '<div class="cavity-diag-title">\u{1F50D} 箱内空间诊断</div>';
    html += '<div class="cavity-diag-grid">';
    html += '<div class="cavity-diag-item"><span class="cavity-diag-label">当前最高点</span><span class="cavity-diag-value">' + diag.maxHeight.toFixed(1) + ' cm</span></div>';
    html += '<div class="cavity-diag-item"><span class="cavity-diag-label">低位空腔数量</span><span class="cavity-diag-value">' + diag.lowCavityCount + '</span></div>';
    html += '<div class="cavity-diag-item"><span class="cavity-diag-label">侧边可用空腔</span><span class="cavity-diag-value">' + diag.sideCavityCount + '</span></div>';
    html += '<div class="cavity-diag-item"><span class="cavity-diag-label">顶部低平台</span><span class="cavity-diag-value">' + diag.topPlatformCount + '</span></div>';
    html += '<div class="cavity-diag-item"><span class="cavity-diag-label">产品夹缝空间</span><span class="cavity-diag-value">' + diag.gapCount + '</span></div>';
    html += '</div>';

    // 未放置诊断
    if (diag.unplacedDiagnostics && diag.unplacedDiagnostics.length > 0) {
        html += '<div class="cavity-diag-subtitle" style="color:#c62828;margin-top:8px;">未低位吸附原因</div>';
        for (const item of diag.unplacedDiagnostics) {
            const dims = item.dims || {};
            html += '<div class="cavity-diag-fail-item">';
            html += '<div><strong>' + (item.skuName || '未知') + '</strong> (' + formatDims(dims) + ' cm, ' + (item.packagingType || '硬包装') + ')</div>';
            if (item.reason) {
                html += '<div style="font-size:12px;color:#c62828;margin-top:2px;">原因: ' + item.reason + '</div>';
            }
            html += '</div>';
        }
    }

    // 空腔数量统计
    if (cavities && cavities.length > 0) {
        const totalVol = cavities.reduce((s, c) => s + c.l * c.w * c.h, 0);
        html += '<div class="cavity-diag-footer">共 ' + cavities.length + ' 个空腔，总体积 ' + totalVol.toFixed(0) + ' cm³</div>';
    }

    html += '</div>';
    diagDiv.innerHTML = html;
    diagDiv.style.display = '';
}

function onEnterSandbox() {
    const select = document.getElementById('viewerSelect');
    if (!select?.value) { alert('请先选择一个箱子查看'); return; }
    const [groupId] = select.value.split('|');
    const group = mixedGroups.find(g => g.id === groupId);
    const boxType = boxTypes.find(b => b.id === group.boxTypeId);
    if (!group || !boxType) return;

    const result = _getLayoutResult(group, boxType);
    if ((result.impossible && result.layers.length === 0 && (!result.overflowItems || result.overflowItems.length === 0))) {
        alert('此混装组无布局数据，无法进入沙盘模式');
        return;
    }
    // 进入沙盘前隐藏诊断面板
    const diag = document.getElementById('cavityDiagnostics');
    if (diag) diag.style.display = 'none';
    if (typeof enterSandboxMode === 'function') {
        enterSandboxMode([], boxType.internal, result.layers, result.overflowItems);
    }
}

// ===== 示例数据 =====

function loadDemoData() {
    // Clear existing
    document.querySelectorAll('#skuBody tr').forEach(tr => tr.remove());
    boxTypes = [];
    mixedGroups = [];

    // Add SKUs from xlsx data（根据 PLAN.md 更新）
    addSkuRow({ name: 'BR-ICE-DRAGON-FBA', length: '43.2', width: '33.0', height: '8.5', qty: '72', pkg: 'hard' });
    addSkuRow({ name: 'BR-STEAM-SUB-FBA', length: '33.0', width: '22.9', height: '10.2', qty: '35', pkg: 'hard' });
    addSkuRow({ name: 'MOC-Double-SafeLocker', length: '12.7', width: '10.2', height: '2.5', qty: '60', pkg: 'soft', tol: '10' });
    addSkuRow({ name: 'MOC-Heavy-SafeLocker', length: '17.8', width: '12.7', height: '2.5', qty: '60', pkg: 'soft', tol: '10' });
    addSkuRow({ name: 'MOC-Single-SafeLocker', length: '15.2', width: '10.2', height: '2.5', qty: '25', pkg: 'soft', tol: '10' });

    // 添加常用箱规（不是全部35个，避免界面太长）
    const commonSizes = [[60,60,60], [60,50,50], [60,40,50], [55,55,55], [50,50,50], [45,45,45]];
    for (const size of commonSizes) {
        addBoxRow({ name: `${size[0]}×${size[1]}×${size[2]}`, length: String(size[0]), width: String(size[1]), height: String(size[2]), wall: String(CONFIG.defaultWallThickness) });
    }

    updateDataFromTables();

    // Auto-create groups similar to xlsx pattern
    autoCreateGroups();

    document.getElementById('resultsSection').style.display = 'block';
}

// ===== 自动分配辅助函数 =====

/**
 * 为单个SKU找到最优的每箱分配数量
 * 策略：floor优先，ceil次之，最后尝试qtyPerBox=1（小批量SKU）
 */
function _findBestPerBox(sku, n, cap) {
    if (cap <= 0) return null;
    const qty = sku.quantity;
    const candidates = [];

    // Strategy 1: floor-based（不超量）
    const perBoxFloor = Math.min(cap, Math.floor(qty / n));
    if (perBoxFloor > 0) {
        const alloc = perBoxFloor * n;
        candidates.push({ qtyPerBox: perBoxFloor, allocated: alloc, remainder: Math.max(0, qty - alloc) });
    }

    // Strategy 2: ceil-based（略超量，但浪费<1个时不放弃）
    const perBoxCeil = Math.min(cap, Math.ceil(qty / n));
    if (perBoxCeil > perBoxFloor) {
        const alloc = perBoxCeil * n;
        if (alloc <= qty) {
            candidates.push({ qtyPerBox: perBoxCeil, allocated: alloc, remainder: qty - alloc });
        } else if (alloc - qty <= 1) {
            candidates.push({ qtyPerBox: perBoxCeil, allocated: qty, remainder: 0 });
        }
    }

    // Strategy 3: qtyPerBox=1（小批量SKU，只用部分箱子）
    if (perBoxFloor === 0 && cap >= 1 && qty > 0) {
        candidates.push({ qtyPerBox: 1, allocated: Math.min(n, qty), remainder: Math.max(0, qty - n) });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.allocated - a.allocated || a.remainder - b.remainder);
    return candidates[0];
}

/**
 * 从候选方案列表中按评分排序，依次验证，返回第一个可行的
 */
function _validateAndPickBest(candidates, allSkus) {
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    for (const cand of candidates) {
        const tempGroup = {
            id: 'temp', name: 'temp',
            boxTypeId: cand.bt.id, boxCount: cand.n,
            assignments: cand.assignments,
        };
        const validation = validateMixedGroup(tempGroup, allSkus, cand.bt.internal);
        if (!validation.impossible) return cand;
    }
    return candidates[0]; // fallback
}

/**
 * 基于已验证布局的真实占用尺寸，反推更贴合的定制箱。
 * 目的：避免选到“能装但过高/过大”的标准箱。
 */
function _optimizeCandidateBoxByLayout(cand, allSkus) {
    if (!cand || !cand.bt || !cand.assignments || cand.assignments.length === 0) return cand;

    const tempGroup = {
        id: 'tighten', name: 'tighten',
        boxTypeId: cand.bt.id,
        boxCount: cand.n,
        assignments: cand.assignments,
    };

    let layout;
    try {
        layout = generateMixedLayout(tempGroup, allSkus, cand.bt.internal);
    } catch (e) {
        return cand;
    }
    if (!layout || !layout.layers || layout.layers.length === 0 || layout.impossible) return cand;

    const used = _calcLayoutUsedDims(layout.layers);
    if (!used || used.length <= 0 || used.width <= 0 || used.height <= 0) return cand;

    const wall = cand.bt.wallThickness || CONFIG.defaultWallThickness;
    const safety = CONFIG.defaultGap || 0.5;
    const internal = dims(
        _roundUp1(used.length + safety),
        _roundUp1(used.width + safety),
        _roundUp1(used.height + safety)
    );
    const external = dims(
        _roundUp1(internal.length + wall * 2),
        _roundUp1(internal.width + wall * 2),
        _roundUp1(internal.height + wall * 2)
    );

    if (Math.max(external.length, external.width, external.height) > CONFIG.maxSide) return cand;

    const oldExternal = cand.bt.external || dims(
        cand.bt.internal.length + wall * 2,
        cand.bt.internal.width + wall * 2,
        cand.bt.internal.height + wall * 2
    );
    const oldVol = dimsVolume(oldExternal);
    const newVol = dimsVolume(external);

    // 体积至少缩小 6% 才自动替换，避免为了几毫米制造大量定制箱。
    if (!(newVol < oldVol * 0.94)) return cand;

    const tightBox = _findOrCreateOptimizedBoxType(external, wall, cand.bt.name);
    const verifyGroup = {
        id: 'tighten_verify', name: 'tighten_verify',
        boxTypeId: tightBox.id,
        boxCount: cand.n,
        assignments: cand.assignments,
    };
    const validation = validateMixedGroup(verifyGroup, allSkus, tightBox.internal);
    if (validation.impossible) return cand;

    const productVol = cand.assignments.reduce((sum, a) => {
        const sku = allSkus.find(s => s.id === a.skuId);
        return sum + (sku ? a.qtyPerBox * dimsVolume(getEffectiveDimensions(sku)) : 0);
    }, 0);

    return {
        ...cand,
        bt: tightBox,
        volUtil: productVol / dimsVolume(tightBox.internal),
        optimizedFrom: cand.bt.name,
        layoutUsed: used,
    };
}

function _calcLayoutUsedDims(layers) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const layer of layers || []) {
        const yOff = layer.yOffset || 0;
        for (const p of layer.placements || []) {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x + (p.length || 0));
            minY = Math.min(minY, yOff);
            maxY = Math.max(maxY, yOff + (p.height || layer.height || 0));
            minZ = Math.min(minZ, p.y);
            maxZ = Math.max(maxZ, p.y + (p.width || 0));
        }
        for (const s of layer.stacks || []) {
            minX = Math.min(minX, s.x);
            maxX = Math.max(maxX, s.x + (s.length || 0));
            minY = Math.min(minY, yOff + (s.stackBase || 0));
            maxY = Math.max(maxY, yOff + (s.stackBase || 0) + (s.height || 0));
            minZ = Math.min(minZ, s.z);
            maxZ = Math.max(maxZ, s.z + (s.width || 0));
        }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)) return null;
    return dims(
        _roundUp1(Math.max(0, maxX - minX)),
        _roundUp1(Math.max(0, maxZ - minZ)),
        _roundUp1(Math.max(0, maxY - minY))
    );
}

function _findOrCreateOptimizedBoxType(external, wall, sourceName) {
    const existing = boxTypes.find(b =>
        Math.abs(b.external.length - external.length) < 0.05 &&
        Math.abs(b.external.width - external.width) < 0.05 &&
        Math.abs(b.external.height - external.height) < 0.05 &&
        Math.abs((b.wallThickness || CONFIG.defaultWallThickness) - wall) < 0.05
    );
    if (existing) return existing;

    const name = `推荐定制 ${formatDims(external)}`;
    const box = {
        id: genBoxId(),
        name,
        external,
        wallThickness: wall,
        internal: dims(
            Math.max(0.1, external.length - wall * 2),
            Math.max(0.1, external.width - wall * 2),
            Math.max(0.1, external.height - wall * 2)
        ),
        optimizedFrom: sourceName,
    };
    boxTypes.push(box);
    renderBoxChips();
    populateStdBoxSelect();
    return box;
}

function _roundUp1(v) {
    return Math.ceil((v || 0) * 10) / 10;
}

/**
 * 计算所有SKU在分配后的剩余数量总和（封顶）
 */
function _calcRemainder(assignments, n, allSkus) {
    const skuMap = {};
    for (const s of allSkus) skuMap[s.id] = s;
    let rem = 0;
    for (const a of assignments) {
        const sku = skuMap[a.skuId];
        if (!sku) continue;
        const used = Math.min(sku.quantity, a.qtyPerBox * n);
        rem += Math.max(0, sku.quantity - used);
    }
    return rem;
}

/**
 * 生成候选方案（纯硬包装或纯软包装）
 */
function _generateCandidates(skusList, allBoxTypes, allSkus, maxUtil) {
    const candidates = [];
    const totalQty = skusList.reduce((s, sk) => s + sk.quantity, 0);
    if (totalQty === 0) return candidates;

    for (const bt of allBoxTypes) {
        const boxVol = dimsVolume(bt.internal);
        if (boxVol <= 0) continue;

        // 计算容量
        const capacities = {};
        let anyFits = false;
        for (const sku of skusList) {
            const effDims = getEffectiveDimensions(sku);
            if (!canFitInBox(effDims, bt.internal)) {
                capacities[sku.id] = 0; continue;
            }
            const p = calcSingleSKUPacking(bt.internal, effDims);
            capacities[sku.id] = p ? p.perBoxCount : 0;
            if (capacities[sku.id] > 0) anyFits = true;
        }
        if (!anyFits) continue;

        for (let n = CONFIG.defaultMinBoxes; n <= CONFIG.maxBoxesToTry; n++) {
            const assignments = [];
            let volPerBox = 0;

            for (const sku of skusList) {
                const cap = capacities[sku.id] || 0;
                if (cap === 0) continue;
                const best = _findBestPerBox(sku, n, cap);
                if (!best || best.qtyPerBox <= 0) continue;
                assignments.push({ skuId: sku.id, qtyPerBox: best.qtyPerBox });
                volPerBox += best.qtyPerBox * dimsVolume(getEffectiveDimensions(sku));
            }
            if (assignments.length === 0) continue;

            const remainder = _calcRemainder(assignments, n, skusList);
            const remainRatio = remainder / totalQty;
            if (remainRatio > 0.30) continue;

            const volUtil = volPerBox / boxVol;
            let score = Math.min(volUtil, maxUtil) * (1 - remainRatio);
            if (remainRatio <= 0.15) score *= 1.2;
            if (n <= 10) score *= 1.1;

            candidates.push({ bt, n, assignments, remainRatio, volUtil, score });
        }
    }
    return candidates;
}

// ===== 自动分配 =====

function autoCreateGroups() {
    updateDataFromTables();
    if (skus.length === 0 || boxTypes.length === 0) {
        alert('请先添加 SKU 和箱子类型');
        return;
    }

    mixedGroups = [];

    const hasHard = skus.some(s => s.packagingType === 'hard');
    const hasSoft = skus.some(s => s.packagingType === 'soft');
    const hardSkus = skus.filter(s => s.packagingType === 'hard');
    const softSkus = skus.filter(s => s.packagingType === 'soft');

    // ───────────────────────────────────────────
    // 情况1：纯硬包装 或 纯软包装 → 单阶段
    // ───────────────────────────────────────────
    if (!hasHard || !hasSoft) {
        const maxUtil = hasHard ? 0.85 : 0.90;
        const candidates = _generateCandidates(skus, boxTypes, skus, maxUtil);
        if (candidates.length === 0) {
            alert('无法找到合适的装箱方案，请检查产品尺寸是否过大');
            return;
        }
        let best = _validateAndPickBest(candidates, skus);
        best = _optimizeCandidateBoxByLayout(best, skus);
        mixedGroups.push({
            id: genGroupId(),
            name: `自动混装 (${best.bt.name}, ${best.n}箱, 利用率${(best.volUtil*100).toFixed(0)}%)`,
            boxTypeId: best.bt.id,
            boxCount: best.n,
            assignments: best.assignments,
        });
        renderGroups();
        document.getElementById('resultsSection').style.display = 'block';
        return;
    }

    // ───────────────────────────────────────────
    // 情况2：硬+软混合 → 先硬后软两阶段
    // ───────────────────────────────────────────

    const totalQty = skus.reduce((s, sk) => s + sk.quantity, 0);

    // Phase 1: 硬包装候选方案
    const hardCandidates = _generateCandidates(hardSkus, boxTypes, skus, 0.85);
    if (hardCandidates.length === 0) {
        // 硬包装没有合适方案 → 回退到全部SKU一起算
        const fallbackCandidates = _generateCandidates(skus, boxTypes, skus, 0.75);
        if (fallbackCandidates.length === 0) {
            alert('无法找到合适的装箱方案，请检查产品尺寸是否过大');
            return;
        }
        let best = _validateAndPickBest(fallbackCandidates, skus);
        best = _optimizeCandidateBoxByLayout(best, skus);
        mixedGroups.push({
            id: genGroupId(),
            name: `自动混装 (${best.bt.name}, ${best.n}箱, 利用率${(best.volUtil*100).toFixed(0)}%)`,
            boxTypeId: best.bt.id,
            boxCount: best.n,
            assignments: best.assignments,
        });
        renderGroups();
        document.getElementById('resultsSection').style.display = 'block';
        return;
    }

    // 验证选出最优硬包装方案
    const bestHard = _validateAndPickBest(hardCandidates, skus);

    // Phase 2: 软包装填充尝试
    const mainAssignments = [...bestHard.assignments];
    const mainN = bestHard.n;
    const mainBt = bestHard.bt;
    const stillRemainingSoft = [];

    // 软包装按压缩后体积从小到大排序（小件更容易填入缝隙）
    const sortedSoft = [...softSkus].sort((a, b) => {
        const va = dimsVolume(getEffectiveDimensions(a));
        const vb = dimsVolume(getEffectiveDimensions(b));
        return va - vb;
    });

    for (const soft of sortedSoft) {
        let found = false;
        for (let qtyPerBox = 1; qtyPerBox <= 3; qtyPerBox++) {
            const testAssignments = [...mainAssignments, { skuId: soft.id, qtyPerBox }];
            const testGroup = {
                id: 'test', name: 'test',
                boxTypeId: mainBt.id, boxCount: mainN,
                assignments: testAssignments,
            };
            // 先检查能否放得进去
            const effDims = getEffectiveDimensions(soft);
            if (!canFitInBox(effDims, mainBt.internal)) continue;
            const validation = validateMixedGroup(testGroup, skus, mainBt.internal);
            if (!validation.impossible) {
                mainAssignments.push({ skuId: soft.id, qtyPerBox });
                found = true;
                break;
            }
        }
        if (!found) {
            stillRemainingSoft.push(soft);
        }
    }

    // Phase 3: 剩余软包装第二组
    let leftoverGroup = null;
    if (stillRemainingSoft.length > 0) {
        const softCandidates = _generateCandidates(stillRemainingSoft, boxTypes, skus, 0.90);
        if (softCandidates.length > 0) {
            let bestSoft = _validateAndPickBest(softCandidates, skus);
            bestSoft = _optimizeCandidateBoxByLayout(bestSoft, skus);
            if (bestSoft) {
                leftoverGroup = {
                    id: genGroupId(),
                    name: `自动混装-软包装 (${bestSoft.bt.name}, ${bestSoft.n}箱, 利用率${(bestSoft.volUtil*100).toFixed(0)}%)`,
                    boxTypeId: bestSoft.bt.id,
                    boxCount: bestSoft.n,
                    assignments: bestSoft.assignments,
                };
            }
        }
    }

    // Phase 4: 计算主组利用率
    const mainVolPerBox = mainAssignments.reduce((sum, a) => {
        const sku = skus.find(s => s.id === a.skuId);
        return sum + (sku ? a.qtyPerBox * dimsVolume(getEffectiveDimensions(sku)) : 0);
    }, 0);
    let mainCandidate = {
        bt: mainBt,
        n: mainN,
        assignments: mainAssignments,
        volUtil: mainVolPerBox / dimsVolume(mainBt.internal),
        score: bestHard.score,
    };
    mainCandidate = _optimizeCandidateBoxByLayout(mainCandidate, skus);
    const finalMainBt = mainCandidate.bt;
    const mainVolUtil = mainVolPerBox / dimsVolume(finalMainBt.internal);

    // 创建主组
    let mainGroupName = `自动混装 (${finalMainBt.name}, ${mainN}箱, 利用率${(mainVolUtil*100).toFixed(0)}%)`;
    if (stillRemainingSoft.length > 0) {
        mainGroupName += `, 软包` + (stillRemainingSoft.length) + `种未填入`;
    }
    mixedGroups.push({
        id: genGroupId(),
        name: mainGroupName,
        boxTypeId: finalMainBt.id,
        boxCount: mainN,
        assignments: mainAssignments,
    });

    // 如果有剩余软包装第二组
    if (leftoverGroup) {
        mixedGroups.push(leftoverGroup);
    }

    renderGroups();
    document.getElementById('resultsSection').style.display = 'block';
}

// ===== 工具 =====

function formatDims(d) {
    if (!d) return '—';
    return `${d.length.toFixed(1)}×${d.width.toFixed(1)}×${d.height.toFixed(1)}`;
}

function printReport() {
    window.print();
}

// ===== xlsx 导入导出代理 =====

function importXlsx() {
    document.getElementById('xlsxInput').click();
}

function handleXlsxImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    // xlsxHandler will override this
    if (window.processXlsxFile) {
        window.processXlsxFile(file);
    } else {
        alert('xlsx 处理模块未加载');
    }
    // 重置 input 值，允许重新选择同一文件
    event.target.value = '';
}

function exportXlsx() {
    updateDataFromTables();
    if (window.generateXlsx) {
        window.generateXlsx(skus, boxTypes, mixedGroups);
    } else {
        // Fallback: generate simple CSV
        alert('xlsx 导出功能需要 SheetJS 库');
    }
}
