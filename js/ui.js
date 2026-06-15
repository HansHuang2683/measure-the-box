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
let _lastViewerBasePayload = null; // { group, boxType, result, boxIdx, cavities }
let _lastViewerPreviewPayload = null; // preview payload uses same shape
let _viewerDisplayMode = 'real';

// ---- 补货推荐状态 ----
let _lastReplenishmentPlan = null;
let _lastBoxReplenishmentAlternatives = [];
let _manualReplenishmentCandidates = [];
let _nextManualReplenishmentId = 1;
let _boxTypeListExpanded = false;
let _groupBoxSearchQueries = {};
let _autoPackingFitMode = 'strict';

/**
 * 根据当前算法设置获取布局结果
 * 新算法返回 { status, productVolume, boxVolume, volumeUtilization, message, layers, cavities, diagnostics }
 * 旧算法返回 { status, productVolume, boxVolume, volumeUtilization, message, layers }
 */
function _getLayoutResult(group, boxType) {
    const boxInternal = boxType.internal;
    let result;
    if (_useCavityAlgorithm && typeof generateMixedLayoutCavity === 'function') {
        try {
            result = generateMixedLayoutCavity(group, skus, boxInternal);
        } catch (e) {
            console.error('空腔吸附算法异常:', e);
            // 降级到原始算法
            result = generateMixedLayout(group, skus, boxInternal);
        }
    } else {
        result = generateMixedLayout(group, skus, boxInternal);
    }
    return _applyMinOverflowSoftFit(group, boxType, result);
}

function _applyMinOverflowSoftFit(group, boxType, result) {
    if (!group || !boxType || !result || group.fitMode !== 'minOverflow') return result;
    const overflow = result.overflowItems || [];
    if (overflow.length === 0) {
        return {
            ...result,
            fitMode: 'min-overflow-soft',
        };
    }
    if (!result.layers || result.layers.length === 0) return result;

    const hardOverflow = overflow.filter(item => item && item.packagingType !== 'soft');
    if (hardOverflow.length > 0) {
        return {
            ...result,
            minOverflowRejectedReason: `仍有 ${hardOverflow.length} 件硬包未放入，硬包不能按软包塑形吸收。`,
        };
    }

    const softOverflow = overflow.filter(item => item && item.packagingType === 'soft');
    if (softOverflow.length === 0) return result;

    const boxOrient = (result.layers && result.layers[0] && result.layers[0].boxOrientation) || boxType.internal;
    const boxVol = dimsVolume(boxOrient);
    const placedItems = _uiExtractPlacedItems(result.layers || []);
    const cavities = _uiBuildCavitiesForResult(result, placedItems, boxOrient);
    const placedPhysicalVolume = placedItems.reduce((s, p) => s + p.l * p.w * p.h, 0);
    const placedOriginalVolume = placedItems.reduce((s, p) => s + (p.originalDims ? dimsVolume(p.originalDims) : p.l * p.w * p.h), 0);
    const overflowPhysicalVolume = softOverflow.reduce((s, item) => s + dimsVolume(item.dims || item.originalDims), 0);
    const overflowOriginalVolume = softOverflow.reduce((s, item) => s + dimsVolume(item.originalDims || item.dims), 0);
    const spareVolume = Math.max(0, boxVol - placedPhysicalVolume);
    const cavityVolume = cavities.reduce((s, c) => s + Math.max(0, c.l) * Math.max(0, c.w) * Math.max(0, c.h), 0);
    const assignedPerBox = group.assignments.reduce((s, a) => s + (parseInt(a.qtyPerBox, 10) || 0), 0);
    const maxSoftOverflow = Math.max(1, Math.ceil(Math.max(assignedPerBox, placedItems.length + softOverflow.length) * 0.12));
    const volumeOk = overflowPhysicalVolume <= spareVolume * 1.12 ||
        overflowPhysicalVolume <= Math.max(spareVolume, cavityVolume * 1.35);

    if (softOverflow.length > maxSoftOverflow || !volumeOk) {
        return {
            ...result,
            minOverflowRejectedReason: `软包未放入 ${softOverflow.length} 件，碎片空腔估算容量不足，建议换大一号箱或降低每箱数量。`,
        };
    }

    const compressedPlacements = _uiBuildMinOverflowSoftPlacements(softOverflow, boxOrient, cavities, placedItems);
    if (compressedPlacements.length === 0) return result;

    return {
        ...result,
        status: PACKING_STATUS.ESTIMATED,
        verifiedFit: false,
        estimatedFit: true,
        impossible: false,
        message: `最少溢出装箱：${softOverflow.length} 件软包按碎片空腔体积塑形压入`,
        fitMode: 'min-overflow-soft',
        overflowItems: [],
        absorbedSoftOverflowItems: softOverflow,
        compressedPlacements,
        physicalPlacements: [],
        realPlacements: placedItems,
        currentPhysicalUtilization: boxVol > 0 ? placedPhysicalVolume / boxVol : 0,
        projectedPhysicalUtilization: boxVol > 0 ? (placedPhysicalVolume + overflowPhysicalVolume) / boxVol : 0,
        currentTheoreticalUtilization: boxVol > 0 ? placedOriginalVolume / boxVol : 0,
        projectedTheoreticalUtilization: boxVol > 0 ? (placedOriginalVolume + overflowOriginalVolume) / boxVol : 0,
        volumeUtilization: boxVol > 0 ? (placedPhysicalVolume + overflowPhysicalVolume) / boxVol : result.volumeUtilization,
        theoreticalModeNote: `最少溢出模式：${softOverflow.length} 件软包没有完整矩形摆放位，但碎片空腔体积足够。绿色块保持原尺寸，显示建议被压入/塑形的位置；硬包不参与该估算。`,
        cavities: result.cavities || cavities,
    };
}

function _getGroupDisplayName(group, boxType, result) {
    if (!group) return '';
    const originalName = group.name || '';
    if (!boxType || !originalName.startsWith('自动混装')) return originalName;
    const utilText = result && Number.isFinite(result.volumeUtilization)
        ? `, 利用率${(result.volumeUtilization * 100).toFixed(0)}%`
        : '';
    return `自动混装 (${boxType.name || formatDims(boxType.external)}, ${group.boxCount || 0}箱${utilText})`;
}

function getViewerDisplayMode() {
    return _viewerDisplayMode || 'real';
}

function setViewerDisplayMode(mode) {
    mode = mode || 'real';
    if (mode === 'compressed' || mode === 'overlay') {
        const ctx = getCurrentViewerGroupAndBox();
        if (!_activeViewerHasCompressedPlacements()) {
            if (!ctx || !_applySoftCompressionModePayload(ctx, true)) {
                _viewerDisplayMode = 'real';
                _syncViewerModeButtons();
                _rerenderActiveViewerPayload();
                return _viewerDisplayMode;
            }
        }
    }
    _viewerDisplayMode = mode;
    _syncViewerModeButtons();
    _rerenderActiveViewerPayload();
    return _viewerDisplayMode;
}

function _applySoftCompressionModePayload(ctx, alertOnEmpty) {
    const basePayload = _ensureViewerBasePayload(ctx);
    if (!basePayload || !basePayload.result) {
        if (alertOnEmpty) alert('当前箱子无法生成 3D 预览');
        return false;
    }

    const softOverflow = (basePayload.result.overflowItems || [])
        .filter(item => item && item.packagingType === 'soft');
    if (softOverflow.length > 0) {
        return _applySoftOverflowPreviewPayload(ctx, basePayload, softOverflow, alertOnEmpty);
    }

    if (_lastReplenishmentPlan &&
        _lastReplenishmentPlan.groupId === ctx.group.id &&
        _lastReplenishmentPlan.boxTypeId === ctx.boxType.id &&
        _lastReplenishmentPlan.compressedPlacements &&
        _lastReplenishmentPlan.compressedPlacements.length > 0) {
        return _applyReplenishmentPreviewPayload(ctx, alertOnEmpty);
    }

    if (alertOnEmpty) {
        alert('当前没有箱外未装的软包。软包塑形估算只处理当前未放入软包；额外采购请使用“补货推荐”。');
    }
    return false;
}

function _syncViewerModeButtons() {
    const buttons = [
        { id: 'viewerModeReal', mode: 'real' },
        { id: 'viewerModeCompressed', mode: 'compressed' },
        { id: 'viewerModeOverlay', mode: 'overlay' },
    ];
    for (const item of buttons) {
        const btn = document.getElementById(item.id);
        if (!btn) continue;
        const active = getViewerDisplayMode() === item.mode;
        btn.classList.toggle('viewer-mode-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
}

function _makeViewerPayload(group, boxType, result, boxIdx, cavities) {
    return {
        group,
        boxType,
        result,
        boxIdx: Number.isFinite(boxIdx) ? boxIdx : 0,
        cavities: cavities || (result && result.cavities) || [],
    };
}

function _storeViewerPayload(payload, preview) {
    if (!payload || !payload.group || !payload.boxType) return;
    if (preview) _lastViewerPreviewPayload = payload;
    else _lastViewerBasePayload = payload;
    _lastViewerContext = { groupId: payload.group.id, boxIdx: payload.boxIdx || 0 };
}

function _getRenderableViewerPayload() {
    const base = _lastViewerBasePayload;
    const preview = _lastViewerPreviewPayload;
    if (preview && base && preview.group && base.group &&
        preview.group.id === base.group.id && preview.boxIdx === base.boxIdx) {
        return preview;
    }
    return base || preview;
}

function _renderViewerPayload(payload, preview) {
    if (!payload) return;
    _storeViewerPayload(payload, !!preview);
    loadGroupIntoViewer(payload.group, payload.boxType, payload.result, payload.boxIdx, payload.cavities);
    _syncViewerModeButtons();
}

function _rerenderActiveViewerPayload() {
    const payload = _getRenderableViewerPayload();
    if (!payload) {
        if (typeof showViewerEmpty === 'function') showViewerEmpty();
        return;
    }
    loadGroupIntoViewer(payload.group, payload.boxType, payload.result, payload.boxIdx, payload.cavities);
    _syncViewerModeButtons();
}

function _activeViewerHasCompressedPlacements() {
    const payload = _getRenderableViewerPayload();
    return !!(payload && payload.result &&
        payload.result.compressedPlacements &&
        payload.result.compressedPlacements.length > 0);
}

function _ensureViewerBasePayload(ctx) {
    if (!ctx) return null;
    if (_lastViewerBasePayload &&
        _lastViewerBasePayload.group &&
        _lastViewerBasePayload.group.id === ctx.group.id &&
        _lastViewerBasePayload.boxIdx === ctx.boxIdx) {
        return _lastViewerBasePayload;
    }
    const result = _getLayoutResult(ctx.group, ctx.boxType);
    if (!result || (result.impossible && (!result.layers || result.layers.length === 0))) return null;
    const payload = _makeViewerPayload(ctx.group, ctx.boxType, result, ctx.boxIdx, result.cavities);
    _storeViewerPayload(payload, false);
    return payload;
}

function _ensureReplenishmentPlanForContext(ctx, silent) {
    if (!ctx) return false;
    if (_lastReplenishmentPlan &&
        _lastReplenishmentPlan.groupId === ctx.group.id &&
        _lastReplenishmentPlan.boxTypeId === ctx.boxType.id) {
        return true;
    }
    try {
        updateDataFromTables();
        _syncManualReplenishmentCandidates();
        const autoCandidates = buildReplenishmentCandidates(skus, mixedGroups, ctx.group, ctx.boxType);
        const manualCandidates = _manualReplenishmentCandidates.map(_manualCandidateToReplenishment);
        const candidates = _mergeReplenishmentCandidates(autoCandidates, manualCandidates);
        if (candidates.length === 0) return false;
        _lastReplenishmentPlan = generateReplenishmentPlan(ctx.group, ctx.boxType, skus, candidates);
        _lastBoxReplenishmentAlternatives = typeof generateBoxReplenishmentAlternatives === 'function'
            ? generateBoxReplenishmentAlternatives(ctx.group, ctx.boxType, skus, candidates, { boxTypes })
            : [];
        const panel = document.getElementById('replenishmentPanel');
        if (panel && panel.style.display !== 'none' && panel.innerHTML.trim()) {
            renderReplenishmentPanel(_lastReplenishmentPlan);
        }
        return true;
    } catch (e) {
        console.error('补货压缩预览计算异常:', e);
        if (!silent) alert('补货压缩预览计算失败：' + e.message);
        return false;
    }
}

function _applySoftOverflowPreviewPayload(ctx, basePayload, softOverflow, alertOnEmpty) {
    const baseResult = basePayload.result;
    const boxOrient = (baseResult.layers && baseResult.layers[0] && baseResult.layers[0].boxOrientation) || ctx.boxType.internal;
    const boxVol = dimsVolume(boxOrient);
    const placedItems = _uiExtractPlacedItems(baseResult.layers || []);
    const cavities = _uiBuildCavitiesForResult(baseResult, placedItems, boxOrient);
    const selections = _uiBuildOverflowSoftSelections(softOverflow);
    let compressedPlacements = [];

    if (typeof _replBuildTheoreticalCompressedPlacements === 'function') {
        compressedPlacements = _replBuildTheoreticalCompressedPlacements(selections, boxOrient, cavities, {
            theoreticalOverlapRatio: 0.16,
            preferTopCavities: true,
            preserveVisualOriginalDims: true,
            fitDisplayInsideCavity: false,
        });
    }
    if (compressedPlacements.length < softOverflow.length) {
        compressedPlacements = _uiFallbackOverflowSoftPlacements(softOverflow, boxOrient, cavities);
    }

    if (compressedPlacements.length === 0) {
        if (alertOnEmpty) alert('当前有未放入软包，但没有可用于展示的压缩空隙。');
        return false;
    }

    const placedPhysicalVolume = placedItems.reduce((s, p) => s + p.l * p.w * p.h, 0);
    const placedOriginalVolume = placedItems.reduce((s, p) => s + (p.originalDims ? dimsVolume(p.originalDims) : p.l * p.w * p.h), 0);
    const overflowPhysicalVolume = compressedPlacements.reduce((s, p) => s + p.length * p.width * p.height, 0);
    const overflowOriginalVolume = softOverflow.reduce((s, item) => s + dimsVolume(item.originalDims || item.dims), 0);
    const overflowByKey = {};
    for (const item of softOverflow) {
        const key = item.skuId || item.skuName || 'soft_overflow';
        if (!overflowByKey[key]) {
            overflowByKey[key] = {
                candidateId: 'overflow_' + key,
                name: item.skuName || '未放入软包',
                packagingType: 'soft',
                qtyPerBox: 0,
                totalQty: 0,
                volumeContribution: 0,
                compressedVolumeContribution: 0,
                placements: [],
                placementSummary: '仅压缩当前箱外未装软包',
                warnings: ['不是补货推荐，不会新增采购数量'],
            };
        }
        overflowByKey[key].qtyPerBox += 1;
        overflowByKey[key].totalQty += ctx.group.boxCount || 1;
        overflowByKey[key].volumeContribution += boxVol > 0 ? dimsVolume(item.originalDims || item.dims) / boxVol : 0;
    }
    for (const p of compressedPlacements) {
        const key = (p.candidateId || '').replace(/^overflow_/, '') || p.skuId || p.skuName;
        const addition = overflowByKey[key] || overflowByKey[p.skuId] || overflowByKey[p.skuName];
        if (addition) {
            addition.placements.push(p);
            addition.compressedVolumeContribution += boxVol > 0 ? (p.length * p.width * p.height) / boxVol : 0;
        }
    }

    const previewResult = {
        ...baseResult,
        fitMode: 'soft-overflow',
        currentPhysicalUtilization: boxVol > 0 ? placedPhysicalVolume / boxVol : 0,
        projectedPhysicalUtilization: boxVol > 0 ? (placedPhysicalVolume + overflowPhysicalVolume) / boxVol : 0,
        currentTheoreticalUtilization: boxVol > 0 ? placedOriginalVolume / boxVol : 0,
        projectedTheoreticalUtilization: boxVol > 0 ? (placedOriginalVolume + overflowOriginalVolume) / boxVol : 0,
        physicalAddedVolume: overflowPhysicalVolume,
        theoreticalAddedVolume: overflowPhysicalVolume,
        theoreticalOriginalAddedVolume: overflowOriginalVolume,
        additions: [],
        physicalAdditions: [],
        theoreticalAdditions: Object.values(overflowByKey),
        compressedPlacements,
        physicalPlacements: [],
        realPlacements: placedItems,
        theoreticalModeNote: `仅显示当前箱外未装的 ${softOverflow.length} 件软包。绿色块保持原尺寸；与蓝色重叠的部分表示需要被压入/挤压，不代表实物变小。`,
        cavities: baseResult.cavities || cavities,
    };
    _renderViewerPayload(_makeViewerPayload(ctx.group, ctx.boxType, previewResult, ctx.boxIdx, previewResult.cavities), true);
    return true;
}

function _uiBuildOverflowSoftSelections(softOverflow) {
    const grouped = {};
    for (const item of softOverflow || []) {
        const key = item.skuId || item.skuName || 'soft_overflow';
        const eff = item.dims || item.originalDims;
        const orig = item.originalDims || item.dims;
        if (!grouped[key]) {
            grouped[key] = {
                candidate: {
                    id: 'overflow_' + key,
                    skuId: item.skuId || key,
                    name: item.skuName || '未放入软包',
                    packagingType: 'soft',
                    dimensions: orig,
                    dims: eff,
                    physicalVolume: dimsVolume(eff),
                    originalVolume: dimsVolume(orig),
                    priority: 10,
                },
                qty: 0,
                physicalVolume: 0,
                originalVolume: 0,
            };
        }
        grouped[key].qty += 1;
        grouped[key].physicalVolume += dimsVolume(eff);
        grouped[key].originalVolume += dimsVolume(orig);
    }
    return Object.values(grouped);
}

function _uiExtractPlacedItems(layers) {
    const items = [];
    for (const layer of layers || []) {
        const yOff = layer.yOffset || 0;
        for (const p of layer.placements || []) {
            items.push({
                x: p.x, y: p.y, z: yOff,
                l: p.length, w: p.width, h: p.height || layer.height,
                skuId: p.skuId, skuName: p.skuName,
                packagingType: p.packagingType,
                originalDims: p.originalDims || null,
            });
        }
        for (const s of layer.stacks || []) {
            items.push({
                x: s.x, y: s.z, z: yOff + (s.stackBase || 0),
                l: s.length, w: s.width, h: s.height,
                skuId: s.skuId, skuName: s.skuName,
                packagingType: s.packagingType,
                originalDims: s.originalDims || null,
            });
        }
    }
    return items;
}

function _uiBuildCavitiesForResult(result, placedItems, boxOrient) {
    if (result && result.cavities && result.cavities.length > 0) return result.cavities;
    if (typeof buildCavitiesFromPlaced === 'function') {
        return buildCavitiesFromPlaced(placedItems, boxOrient.length, boxOrient.width, boxOrient.height)
            .filter(c => c && c.l > 0.1 && c.w > 0.1 && c.h > 0.1 && c.l * c.w * c.h > 0.5);
    }
    return [{ x: 0, y: 0, z: 0, l: boxOrient.length, w: boxOrient.width, h: boxOrient.height, source: 'fallback' }];
}

function _uiFallbackOverflowSoftPlacements(softOverflow, boxOrient, cavities) {
    const usable = (cavities || []).filter(c => c && c.l > 0.1 && c.w > 0.1 && c.h > 0.1)
        .sort((a, b) => {
            const aSide = (a.x < 0.01 || a.y < 0.01 || Math.abs(a.x + a.l - boxOrient.length) < 0.01 || Math.abs(a.y + a.w - boxOrient.width) < 0.01) ? 1 : 0;
            const bSide = (b.x < 0.01 || b.y < 0.01 || Math.abs(b.x + b.l - boxOrient.length) < 0.01 || Math.abs(b.y + b.w - boxOrient.width) < 0.01) ? 1 : 0;
            return b.z - a.z || bSide - aSide || b.l * b.w * b.h - a.l * a.w * a.h;
        });
    const baseCavity = usable[0] || { x: 0, y: 0, z: Math.max(0, boxOrient.height - 2), l: boxOrient.length, w: boxOrient.width, h: Math.min(2, boxOrient.height) };
    return (softOverflow || []).map((item, idx) => {
        const d = item.dims || item.originalDims;
        const visual = item.originalDims || d;
        const display = dims(
            Math.max(0.12, visual.length),
            Math.max(0.12, visual.width),
            Math.max(0.12, visual.height)
        );
        const step = Math.max(0.2, display.length * 0.72);
        const x = Math.min(Math.max(0, boxOrient.length - display.length), baseCavity.x + (idx % 4) * step);
        const z = Math.min(Math.max(0, boxOrient.width - display.width), baseCavity.y + (Math.floor(idx / 4) % 3) * Math.max(0.2, display.width * 0.72));
        const y = baseCavity.z + display.height > boxOrient.height
            ? Math.max(0, boxOrient.height - display.height)
            : Math.min(Math.max(0, boxOrient.height - display.height), baseCavity.z + Math.floor(idx / 12) * Math.max(0.12, display.height * 0.5));
        return {
            skuId: item.skuId,
            candidateId: 'overflow_' + (item.skuId || item.skuName || 'soft'),
            skuName: item.skuName || '未放入软包',
            packagingType: 'soft',
            originalDims: item.originalDims || item.dims,
            effectiveDims: item.dims || item.originalDims,
            theoretical: true,
            virtual: true,
            colorHex: 0x22c55e,
            x, y, z,
            length: display.length,
            width: display.width,
            height: display.height,
            overlapRatio: 0.28,
            compressionRatio: dimsVolume(display) / Math.max(0.0001, dimsVolume(item.originalDims || item.dims)),
            preserveVisualOriginalDims: true,
            visualOverlapDepth: Math.max(0, display.height - baseCavity.h),
            placementSummary: '仅当前未放入软包压缩展示',
        };
    });
}

function _uiOrientationsForDims(d) {
    if (!d) return [];
    const raw = [
        dims(d.length, d.width, d.height),
        dims(d.width, d.length, d.height),
    ];
    const seen = new Set();
    return raw.filter(o => {
        const key = `${o.length.toFixed(4)}|${o.width.toFixed(4)}|${o.height.toFixed(4)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return o.length > 0 && o.width > 0 && o.height > 0;
    });
}

function _uiRankSoftCavity(c, boxOrient) {
    const atSide = (c.x < 0.1 || c.y < 0.1 ||
        Math.abs(c.x + c.l - boxOrient.length) < 0.1 ||
        Math.abs(c.y + c.w - boxOrient.width) < 0.1) ? 1 : 0;
    const topBias = c.z / Math.max(0.1, boxOrient.height);
    const sideBias = atSide * 0.35;
    return topBias + sideBias + Math.min(0.25, (c.l * c.w) / Math.max(1, boxOrient.length * boxOrient.width));
}

function _uiTopHeightUnderFootprint(placedItems, x, y, l, w) {
    let top = 0;
    for (const item of placedItems || []) {
        const xOverlap = Math.max(0, Math.min(x + l, item.x + item.l) - Math.max(x, item.x));
        const yOverlap = Math.max(0, Math.min(y + w, item.y + item.w) - Math.max(y, item.y));
        if (xOverlap <= 0 || yOverlap <= 0) continue;
        top = Math.max(top, (item.z || 0) + (item.h || 0));
    }
    return top;
}

function _uiFindLeastOccupiedSoftSlot(display, boxOrient, placedItems, idx) {
    const step = Math.max(0.5, Math.min(display.length, display.width) / 4);
    const maxX = Math.max(0, boxOrient.length - display.length);
    const maxY = Math.max(0, boxOrient.width - display.width);
    const xSteps = Math.max(1, Math.ceil(maxX / step));
    const ySteps = Math.max(1, Math.ceil(maxY / step));
    let best = null;

    for (let xi = 0; xi <= xSteps; xi++) {
        const x = xi === xSteps ? maxX : Math.min(maxX, xi * step);
        for (let yi = 0; yi <= ySteps; yi++) {
            const y = yi === ySteps ? maxY : Math.min(maxY, yi * step);
            const top = _uiTopHeightUnderFootprint(placedItems, x, y, display.length, display.width);
            const overflow = Math.max(0, top + display.height - boxOrient.height);
            const stagger = ((xi + yi + idx) % 3) * 0.01;
            // 视觉优先：先找底下占用最低的真实空位；若高度相近，优先放在左前角，
            // 这样用户肉眼看到的低位空白会先被补上，而不是飘到远端上沿。
            const frontLeftBias = x * 0.35 + y * 0.35;
            const score = top * 20 + overflow * 60 + frontLeftBias + stagger;
            if (!best || score < best.score) best = { x, y, top, overflow, score };
        }
    }
    if (!best) return { x: 0, y: 0, top: 0, overflow: 0, score: 0 };
    return best;
}

function _uiFindCavitySoftSlot(display, cavity, boxOrient) {
    if (!cavity) return null;
    const x = Math.min(Math.max(0, boxOrient.length - display.length), Math.max(0, cavity.x));
    const z = Math.min(Math.max(0, boxOrient.width - display.width), Math.max(0, cavity.y));
    const y = Math.min(Math.max(0, boxOrient.height - display.height), Math.max(0, cavity.z));
    const overL = Math.max(0, display.length - cavity.l);
    const overW = Math.max(0, display.width - cavity.w);
    const overH = Math.max(0, display.height - cavity.h);
    const score = cavity.z * 22 + x * 0.45 + z * 0.45 + overL * 2.5 + overW * 2.5 + overH * 8;
    return { x, y: z, top: y, overflow: overH, score, overL, overW, overH };
}

function _uiChooseSoftPlacementForCavity(item, cavity, boxOrient, idx, placedItems) {
    const original = item.originalDims || item.dims;
    const effective = item.dims || item.originalDims;
    const orientations = _uiOrientationsForDims(original);
    let best = null;
    for (const o of orientations) {
        const cavitySlot = _uiFindCavitySoftSlot(o, cavity, boxOrient);
        const heightSlot = _uiFindLeastOccupiedSoftSlot(o, boxOrient, placedItems, idx);
        const slot = cavitySlot && cavitySlot.score <= heightSlot.score + 80 ? cavitySlot : heightSlot;
        const overL = cavitySlot ? cavitySlot.overL : Math.max(0, o.length - cavity.l);
        const overW = cavitySlot ? cavitySlot.overW : Math.max(0, o.width - cavity.w);
        const overH = Math.max(0, slot.top + o.height - boxOrient.height);
        const outsidePenalty = overL * 3 + overW * 3 + overH * 2;
        const squeezePenalty = Math.max(0, dimsVolume(o) - dimsVolume(effective)) / Math.max(1, dimsVolume(original));
        const score = outsidePenalty + squeezePenalty + slot.score + Math.abs(o.height - original.height) * 0.04;
        if (!best || score < best.score) best = { dims: o, score, overL, overW, overH, slot };
    }
    const display = best ? best.dims : original;
    const slot = best && best.slot ? best.slot : _uiFindLeastOccupiedSoftSlot(display, boxOrient, placedItems, idx);
    const x = slot.x;
    const z = slot.y;
    const y = Math.min(Math.max(0, boxOrient.height - display.height), Math.max(0, slot.top));

    return {
        skuId: item.skuId,
        candidateId: 'overflow_' + (item.skuId || item.skuName || 'soft'),
        skuName: item.skuName || '未放入软包',
        packagingType: 'soft',
        originalDims: item.originalDims || item.dims,
        effectiveDims: item.dims || item.originalDims,
        theoretical: true,
        virtual: true,
        colorHex: 0x22c55e,
        edgeColorHex: 0x15803d,
        x, y, z,
        length: display.length,
        width: display.width,
        height: display.height,
        overlapRatio: Math.max(0.12, Math.min(0.45, best ? (best.overL + best.overW + best.overH) / Math.max(1, display.length + display.width + display.height) : 0.25)),
        compressionRatio: dimsVolume(effective) / Math.max(0.0001, dimsVolume(original)),
        preserveVisualOriginalDims: true,
        visualOverlapDepth: best ? Math.max(0, best.overH) : 0,
        clusterLabel: item.skuName || '软包塑形',
        placementSummary: '最少溢出软包塑形',
    };
}

function _uiBuildMinOverflowSoftPlacements(softOverflow, boxOrient, cavities, placedItems) {
    const usable = (cavities || [])
        .filter(c => c && c.l > 0.2 && c.w > 0.2 && c.h > 0.05)
        .sort((a, b) =>
            a.z - b.z ||
            (a.x + a.y) - (b.x + b.y) ||
            (b.l * b.w * b.h) - (a.l * a.w * a.h)
        );
    const fallback = {
        x: 0,
        y: 0,
        z: Math.max(0, boxOrient.height - Math.max(...(softOverflow || []).map(i => (i.originalDims || i.dims || {}).height || 1))),
        l: boxOrient.length,
        w: boxOrient.width,
        h: Math.min(3, boxOrient.height),
    };
    const pool = usable.length > 0 ? usable : [fallback];
    const occupied = (placedItems || []).map(p => ({ ...p }));
    return (softOverflow || []).map((item, idx) => {
        const cavity = pool[idx % pool.length];
        const placement = _uiChooseSoftPlacementForCavity(item, cavity, boxOrient, idx, occupied);
        occupied.push({
            x: placement.x,
            y: placement.z,
            z: placement.y,
            l: placement.length,
            w: placement.width,
            h: placement.height,
        });
        return placement;
    });
}

function _applyReplenishmentPreviewPayload(ctx, alertOnEmpty) {
    if (!ctx) return false;
    if (!_ensureReplenishmentPlanForContext(ctx, !alertOnEmpty)) {
        if (alertOnEmpty) alert('当前没有可预览的软包补货候选。压缩/叠加模式只用于软包补货估算，不压缩硬包。');
        return false;
    }
    if (!_lastReplenishmentPlan ||
        !_lastReplenishmentPlan.compressedPlacements ||
        _lastReplenishmentPlan.compressedPlacements.length === 0) {
        const note = _lastReplenishmentPlan && _lastReplenishmentPlan.theoreticalModeNote
            ? _lastReplenishmentPlan.theoreticalModeNote
            : '当前没有可预览的软包补货候选。';
        if (alertOnEmpty) alert(note + ' 压缩/叠加模式只用于软包补货估算，不压缩硬包。');
        return false;
    }

    const basePayload = _ensureViewerBasePayload(ctx);
    if (!basePayload || !basePayload.result) {
        if (alertOnEmpty) alert('当前箱子无法生成 3D 预览');
        return false;
    }
    const previewResult = {
        ...basePayload.result,
        fitMode: 'dual',
        boxOrientation: _lastReplenishmentPlan.boxOrientation || ctx.boxType.internal,
        currentPhysicalUtilization: _lastReplenishmentPlan.currentPhysicalUtilization,
        projectedPhysicalUtilization: _lastReplenishmentPlan.projectedPhysicalUtilization,
        currentTheoreticalUtilization: _lastReplenishmentPlan.currentTheoreticalUtilization,
        projectedTheoreticalUtilization: _lastReplenishmentPlan.projectedTheoreticalUtilization,
        currentUtilization: _lastReplenishmentPlan.currentPhysicalUtilization,
        projectedUtilization: _lastReplenishmentPlan.projectedPhysicalUtilization,
        physicalAddedVolume: _lastReplenishmentPlan.physicalAddedVolume,
        theoreticalAddedVolume: _lastReplenishmentPlan.theoreticalAddedVolume,
        theoreticalOriginalAddedVolume: _lastReplenishmentPlan.theoreticalOriginalAddedVolume,
        additions: _lastReplenishmentPlan.physicalAdditions || [],
        physicalAdditions: _lastReplenishmentPlan.physicalAdditions || [],
        theoreticalAdditions: _lastReplenishmentPlan.theoreticalAdditions || [],
        compressedPlacements: _lastReplenishmentPlan.compressedPlacements || [],
        physicalPlacements: _lastReplenishmentPlan.physicalPlacements || [],
        realPlacements: _lastReplenishmentPlan.realPlacements || [],
        theoreticalModeNote: _lastReplenishmentPlan.theoreticalModeNote,
        overflowItems: basePayload.result.overflowItems || [],
        cavities: basePayload.result.cavities || [],
    };
    _renderViewerPayload(_makeViewerPayload(ctx.group, ctx.boxType, previewResult, ctx.boxIdx, previewResult.cavities), true);
    return true;
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
                _renderViewerPayload(_makeViewerPayload(group, boxType, oldResult, _lastViewerContext.boxIdx), false);
                return;
            }
        }
        if (typeof showViewerEmpty === 'function') showViewerEmpty();
        return;
    }
    _renderViewerPayload(_makeViewerPayload(group, boxType, result, _lastViewerContext.boxIdx, result.cavities), false);
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
        clearReplenishmentPreview();
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
    const resultHtml = plan ? _renderReplenishmentResultV2(plan) : '<div class="replenishment-empty">点击“重新计算”后生成每箱补货数量和预计利用率提升。</div>';
    const displayGroupName = _getGroupDisplayName(ctx.group, ctx.boxType, _lastViewerBasePayload?.result);

    panel.innerHTML = `
        <div class="replenishment-panel">
            <div class="replenishment-header">
                <div>
                    <div class="replenishment-title">剩余空间补货推荐</div>
                    <div class="replenishment-meta">${_escapeReplenishmentHtml(displayGroupName)} | ${_escapeReplenishmentHtml(ctx.boxType.name)} | ${ctx.group.boxCount} 箱</div>
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
        _lastBoxReplenishmentAlternatives = [];
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
        _lastBoxReplenishmentAlternatives = typeof generateBoxReplenishmentAlternatives === 'function'
            ? generateBoxReplenishmentAlternatives(ctx.group, ctx.boxType, skus, candidates, { boxTypes })
            : [];
        renderReplenishmentPanel(_lastReplenishmentPlan);
        if (getViewerDisplayMode() === 'compressed' || getViewerDisplayMode() === 'overlay') {
            _applyReplenishmentPreviewPayload(ctx, false);
        }
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
    if (_applyReplenishmentPreviewPayload(ctx, true)) {
        setViewerDisplayMode('compressed');
    }
}

function clearReplenishmentPreview() {
    _lastViewerPreviewPayload = null;
    _rerenderActiveViewerPayload();
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

function _renderBoxReplenishmentAlternatives(alternatives, currentPlan) {
    if (!alternatives || alternatives.length === 0) return '';
    const currentBoxId = currentPlan ? currentPlan.boxTypeId : '';
    return `
        <div class="replenishment-box-alt">
            <div class="replenishment-subtitle">已有箱型遍历</div>
            <div class="replenishment-alt-note">只遍历第二步箱型列表，不自动替换当前方案；用于判断购买哪种箱，以及每箱还需要补多少小彩盒。软包按大胆压缩估算。</div>
            <div class="replenishment-table-wrap">
                <table class="replenishment-result-table">
                    <thead>
                        <tr><th>候选箱型</th><th>当前利用率</th><th>补货后</th><th>每箱补货</th><th>建议补货结构</th><th>箱体变化</th><th>操作</th></tr>
                    </thead>
                    <tbody>
                        ${alternatives.map((alt, idx) => {
                            const b = alt.boxType;
                            const p = alt.plan;
                            const addText = p.additions && p.additions.length > 0
                                ? p.additions.map(a => `${a.name}×${a.qtyPerBox}/箱`).join('；')
                                : '无需/无法补货';
                            const change = alt.volumeDelta < -0.01
                                ? `箱体约小 ${Math.abs(alt.volumeDelta * 100).toFixed(0)}%`
                                : alt.volumeDelta > 0.01
                                    ? `箱体约大 ${(alt.volumeDelta * 100).toFixed(0)}%`
                                    : '接近当前箱';
                            const currentMark = b.id === currentBoxId ? '（当前）' : '';
                            return `
                                <tr>
                                    <td><strong>${formatDims(b.external)}</strong> cm${currentMark}</td>
                                    <td>${_formatPercent(p.currentUtilization)}</td>
                                    <td><strong>${_formatPercent(p.projectedUtilization)}</strong></td>
                                    <td>${alt.addedQtyPerBox} 件/箱</td>
                                    <td>${_escapeReplenishmentHtml(addText)}</td>
                                    <td>${change}</td>
                                    <td><button class="btn btn-sm btn-outline replenishment-preview-btn" onclick="previewBoxReplenishmentAlternative(${idx})">3D 预览</button></td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function _renderReplenishmentResultV2(plan) {
    const currentPhysical = _formatPercent(plan.currentPhysicalUtilization != null ? plan.currentPhysicalUtilization : plan.currentUtilization);
    const projectedPhysical = _formatPercent(plan.projectedPhysicalUtilization != null ? plan.projectedPhysicalUtilization : plan.projectedUtilization);
    const currentTheoretical = _formatPercent(plan.currentTheoreticalUtilization || 0);
    const projectedTheoretical = _formatPercent(plan.projectedTheoreticalUtilization || 0);
    const physicalGain = _formatPercent(Math.max(0,
        (plan.projectedPhysicalUtilization != null ? plan.projectedPhysicalUtilization : plan.projectedUtilization || 0) -
        (plan.currentPhysicalUtilization != null ? plan.currentPhysicalUtilization : plan.currentUtilization || 0)
    ));
    const theoreticalGain = _formatPercent(Math.max(0, (plan.projectedTheoreticalUtilization || 0) - (plan.currentTheoreticalUtilization || 0)));
    const physicalAdditions = plan.physicalAdditions || plan.additions || [];
    const theoreticalAdditions = plan.theoreticalAdditions || [];

    let html = `
        <div class="replenishment-summary">
            <div><span>物理当前</span><strong>${currentPhysical}</strong></div>
            <div><span>物理推荐</span><strong>${projectedPhysical}</strong></div>
            <div><span>理论当前</span><strong>${currentTheoretical}</strong></div>
            <div><span>理论推荐</span><strong>${projectedTheoretical}</strong></div>
        </div>
        <div class="replenishment-note-strip">
            <span>物理提升 ${physicalGain}</span>
            <span>理论提升 ${theoreticalGain}</span>
            <span>空腔 ${(plan.cavitiesBefore || []).length} 个</span>
        </div>
    `;

    if (physicalAdditions.length === 0 && theoreticalAdditions.length === 0) {
        html += '<div class="replenishment-empty">暂无可推荐的补货候选。可以继续补充更小的软包，或者在第二步添加/选择更合适的箱型。</div>';
    }

    if (physicalAdditions.length > 0) {
        html += `
            <div class="replenishment-table-wrap">
                <div class="replenishment-subtitle">物理安全推荐</div>
                <table class="replenishment-result-table">
                    <thead>
                        <tr>
                            <th>推荐 SKU</th><th>包装</th><th>每箱建议</th><th>${plan.boxCount} 箱合计</th><th>物理贡献</th><th>摆放区域</th><th>提示</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${physicalAdditions.map(a => `
                            <tr>
                                <td>${_escapeReplenishmentHtml(a.name)}</td>
                                <td>${a.packagingType === 'soft' ? '软包' : '硬盒彩盒'}</td>
                                <td><strong>${a.qtyPerBox}</strong> 件/箱</td>
                                <td><strong>${a.totalQty}</strong> 件</td>
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

    if (theoreticalAdditions.length > 0) {
        html += `
            <div class="replenishment-table-wrap">
                <div class="replenishment-subtitle">软包极限压缩推荐</div>
                <table class="replenishment-result-table">
                    <thead>
                        <tr>
                            <th>推荐 SKU</th><th>包装</th><th>每箱建议</th><th>${plan.boxCount} 箱合计</th><th>理论贡献</th><th>压缩后贡献</th><th>模式</th><th>提示</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${theoreticalAdditions.map(a => `
                            <tr>
                                <td>${_escapeReplenishmentHtml(a.name)}</td>
                                <td>${a.packagingType === 'soft' ? '软包' : '硬盒彩盒'}</td>
                                <td><strong>${a.qtyPerBox}</strong> 件/箱</td>
                                <td><strong>${a.totalQty}</strong> 件</td>
                                <td>${_formatPercent(a.volumeContribution)}</td>
                                <td>${_formatPercent(a.compressedVolumeContribution)}</td>
                                <td>${_escapeReplenishmentHtml(a.placementSummary)}</td>
                                <td>${(a.warnings || []).map(_escapeReplenishmentHtml).join('；') || '—'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    if (plan.theoreticalModeNote) {
        html += '<div class="replenishment-notes"><strong>理论模式说明</strong><span>' + _escapeReplenishmentHtml(plan.theoreticalModeNote) + '</span></div>';
    }
    if (plan.unusableReasons && plan.unusableReasons.length > 0) {
        html += '<div class="replenishment-notes"><strong>剩余不可用空间：</strong>' +
            plan.unusableReasons.map(r => '<span>' + _escapeReplenishmentHtml(r) + '</span>').join('') +
            '</div>';
    }
    html += _renderBoxReplenishmentAlternativesV2(_lastBoxReplenishmentAlternatives, plan);
    return html;
}

function _renderBoxReplenishmentAlternativesV2(alternatives, currentPlan) {
    if (!alternatives || alternatives.length === 0) return '';
    const currentBoxId = currentPlan ? currentPlan.boxTypeId : '';
    return `
        <div class="replenishment-box-alt">
            <div class="replenishment-subtitle">已有箱型遍历</div>
            <div class="replenishment-alt-note">只遍历第二步箱型列表，不自动替换当前方案；用于判断采购哪种箱，以及每箱还能补多少小彩盒。软包按大胆压缩估算。</div>
            <div class="replenishment-table-wrap">
                <table class="replenishment-result-table">
                    <thead>
                        <tr>
                            <th>候选箱型</th><th>物理当前</th><th>物理推荐</th><th>理论当前</th><th>理论推荐</th><th>物理补货</th><th>理论补货</th><th>箱体变化</th><th>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${alternatives.map((alt, idx) => {
                            const b = alt.boxType;
                            const p = alt.plan;
                            const physicalAddQty = alt.physicalAddedQtyPerBox || 0;
                            const theoreticalAddQty = alt.theoreticalAddedQtyPerBox || 0;
                            const addText = (p.physicalAdditions && p.physicalAdditions.length > 0)
                                ? p.physicalAdditions.map(a => `${a.name}×${a.qtyPerBox}/箱`).join('，')
                                : '无物理补货';
                            const theoreticalText = (p.theoreticalAdditions && p.theoreticalAdditions.length > 0)
                                ? p.theoreticalAdditions.map(a => `${a.name}×${a.qtyPerBox}/箱`).join('，')
                                : '无理论补货';
                            const currentMark = b.id === currentBoxId ? '（当前）' : '';
                            const change = alt.volumeDelta < -0.01
                                ? `箱体约小 ${Math.abs(alt.volumeDelta * 100).toFixed(0)}%`
                                : alt.volumeDelta > 0.01
                                    ? `箱体约大 ${(alt.volumeDelta * 100).toFixed(0)}%`
                                    : '接近当前箱';
                            return `
                                <tr>
                                    <td><strong>${formatDims(b.external)}</strong> cm${currentMark}</td>
                                    <td>${_formatPercent(p.currentPhysicalUtilization != null ? p.currentPhysicalUtilization : p.currentUtilization)}</td>
                                    <td><strong>${_formatPercent(p.projectedPhysicalUtilization != null ? p.projectedPhysicalUtilization : p.projectedUtilization)}</strong></td>
                                    <td>${_formatPercent(p.currentTheoreticalUtilization || 0)}</td>
                                    <td><strong>${_formatPercent(p.projectedTheoreticalUtilization || 0)}</strong></td>
                                    <td>${physicalAddQty} 件/箱<br><span style="color:#64748B;font-size:11px;">${_escapeReplenishmentHtml(addText)}</span></td>
                                    <td>${theoreticalAddQty} 件/箱<br><span style="color:#64748B;font-size:11px;">${_escapeReplenishmentHtml(theoreticalText)}</span></td>
                                    <td>${change}</td>
                                    <td><button class="btn btn-sm btn-outline replenishment-preview-btn" onclick="previewBoxReplenishmentAlternative(${idx})">3D 预览</button></td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function previewBoxReplenishmentAlternative(index) {
    const alt = _lastBoxReplenishmentAlternatives[index];
    if (!alt || !alt.boxType || !alt.plan) {
        alert('该候选箱型暂无可预览的 3D 方案');
        return;
    }
    const ctx = getCurrentViewerGroupAndBox();
    if (!ctx) {
        alert('请先选择一个箱子预览');
        return;
    }
    try {
        if (typeof exitSandboxMode === 'function') exitSandboxMode();
        const result = alt.plan.baseResult || (
            typeof generateMixedLayoutCavity === 'function'
                ? generateMixedLayoutCavity(ctx.group, skus, alt.boxType.internal)
                : generateMixedLayout(ctx.group, skus, alt.boxType.internal)
        );
        if (!result || (result.impossible && (!result.layers || result.layers.length === 0))) {
            alert('该候选箱型无法生成完整 3D 预览');
            return;
        }
        const previewResult = {
            ...result,
            fitMode: 'dual',
            boxOrientation: alt.plan.boxOrientation || alt.boxType.internal,
            currentPhysicalUtilization: alt.plan.currentPhysicalUtilization,
            projectedPhysicalUtilization: alt.plan.projectedPhysicalUtilization,
            currentTheoreticalUtilization: alt.plan.currentTheoreticalUtilization,
            projectedTheoreticalUtilization: alt.plan.projectedTheoreticalUtilization,
            currentUtilization: alt.plan.currentPhysicalUtilization,
            projectedUtilization: alt.plan.projectedPhysicalUtilization,
            physicalAddedVolume: alt.plan.physicalAddedVolume,
            theoreticalAddedVolume: alt.plan.theoreticalAddedVolume,
            theoreticalOriginalAddedVolume: alt.plan.theoreticalOriginalAddedVolume,
            additions: alt.plan.physicalAdditions || [],
            physicalAdditions: alt.plan.physicalAdditions || [],
            theoreticalAdditions: alt.plan.theoreticalAdditions || [],
            compressedPlacements: alt.plan.compressedPlacements || [],
            physicalPlacements: alt.plan.physicalPlacements || [],
            realPlacements: alt.plan.realPlacements || [],
            theoreticalModeNote: alt.plan.theoreticalModeNote,
        };
        _renderViewerPayload(_makeViewerPayload(ctx.group, alt.boxType, previewResult, 0, result.cavities), true);
        setViewerDisplayMode('overlay');
        const viewer = document.getElementById('viewer-container');
        if (viewer) viewer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
        console.error('候选箱型 3D 预览失败:', e);
        alert('候选箱型 3D 预览失败：' + e.message);
    }
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
    // 默认添加全部预置箱规；第二步箱型列表已折叠，箱型多也不会撑长页面
    for (const size of STANDARD_BOX_SIZES) {
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
    renderBoxChips();
    // 重新生成下拉菜单（过滤已添加的箱规）
    populateStdBoxSelect();
    renderGroups();
    _syncViewerModeButtons();
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
        if (inputs.length < 8) continue;
        const name = inputs[0].value.trim();
        if (!name) continue;
        const l = parseFloat(inputs[1].value);
        const w = parseFloat(inputs[2].value);
        const h = parseFloat(inputs[3].value);
        const qty = parseInt(inputs[4].value) || 0;
        const unitWeight = parseFloat(inputs[5].value) || 0;
        const pkgType = inputs[6].value;
        const tol = parseFloat(inputs[7].value) || 0;
        const id = row.dataset.skuId || genSkuId();
        row.dataset.skuId = id;
        if (l > 0 && w > 0 && h > 0 && qty > 0) {
            result.push({
                id, name, quantity: qty,
                dimensions: dims(l, w, h),
                unitWeight,
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
        <td><input type="number" step="0.001" min="0" placeholder="kg/件" value="${data?.weight || ''}"></td>
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
    if (inputs.length < 8) return;
    const data = {
        name: inputs[0].value,
        length: inputs[1].value,
        width: inputs[2].value,
        height: inputs[3].value,
        qty: inputs[4].value,
        weight: inputs[5].value,
        pkg: inputs[6].value,
        tol: inputs[7].value,
    };
    addSkuRow(data);
}

function deleteSkuRow(btn) {
    const tr = btn.closest('tr');
    tr.remove();
    updateSkuEmpties();
}

// ===== 箱子类型管理（芯片式） =====

function addBoxRow(data, options) {
    options = options || {};
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
    if (!options.suppressSync) _syncBoxTypeDependents();
    return box;
}

function deleteBoxRow(boxId) {
    boxTypes = boxTypes.filter(b => b.id !== boxId);
    for (const group of mixedGroups) {
        if (group.boxTypeId === boxId) {
            group.boxTypeId = boxTypes.length > 0 ? boxTypes[0].id : '';
        }
    }
    if (_lastViewerContext) {
        const group = mixedGroups.find(g => g.id === _lastViewerContext.groupId);
        if (!group || group.boxTypeId === boxId || !boxTypes.some(b => b.id === group.boxTypeId)) {
            _lastViewerContext = null;
            _lastViewerBasePayload = null;
            _lastViewerPreviewPayload = null;
            if (typeof showViewerEmpty === 'function') showViewerEmpty();
        }
    }
    _syncBoxTypeDependents();
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
    const activeBoxId = _getActiveBoxTypeId();
    const visibleBoxes = _boxTypeListExpanded ? boxTypes : boxTypes.slice(0, 8);
    const hiddenCount = Math.max(0, boxTypes.length - visibleBoxes.length);
    container.innerHTML = `
        <div class="box-list-summary">
            <div>
                <strong>已添加箱型：${boxTypes.length} 个</strong>
                <span>${_boxTypeListExpanded ? '展开全部箱型，点击“使用”可同步到当前混装组和 3D。' : hiddenCount > 0 ? `当前显示前 ${visibleBoxes.length} 个，还有 ${hiddenCount} 个已折叠。` : '当前箱型较少，无需展开。'}</span>
            </div>
            <button class="btn btn-sm btn-outline" onclick="toggleBoxTypeList()">${_boxTypeListExpanded ? '折叠箱型' : '展开选择箱型'}</button>
        </div>
        <div class="box-chip-grid ${_boxTypeListExpanded ? 'expanded' : 'collapsed'}">
            ${visibleBoxes.map(bt => `
                <div class="box-chip ${bt.id === activeBoxId ? 'box-chip-active' : ''}" title="外${formatDims(bt.external)} 壁厚${bt.wallThickness}cm 内${formatDims(bt.internal)}">
                    <button class="box-chip-main" onclick="useBoxTypeForActiveGroup('${bt.id}')" title="使用此箱型">
                        <span class="box-chip-name">${_escapeReplenishmentHtml(bt.name)}</span>
                        <span class="box-chip-dims">外${formatDims(bt.external)} / 内${formatDims(bt.internal)}</span>
                    </button>
                    <div class="box-chip-actions">
                        <button class="btn btn-sm btn-primary" onclick="useBoxTypeForActiveGroup('${bt.id}')" title="同步到当前混装组和 3D">使用</button>
                        <button class="btn btn-sm btn-outline" onclick="duplicateBoxRow('${bt.id}')" title="复制" style="min-width:24px;padding:0 4px;font-size:11px;">📋</button>
                        <button class="btn btn-sm btn-danger" onclick="deleteBoxRow('${bt.id}')" title="删除">×</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
    document.getElementById('boxEmpty').style.display = 'none';
}

function updateBoxEmpties() {
    const empty = document.getElementById('boxEmpty');
    if (empty) empty.style.display = boxTypes.length === 0 ? 'block' : 'none';
}

function toggleBoxTypeList() {
    _boxTypeListExpanded = !_boxTypeListExpanded;
    renderBoxChips();
}

function _syncBoxTypeDependents() {
    for (const box of boxTypes) _repairBoxTypeDimensions(box);
    for (const group of mixedGroups) {
        if (!boxTypes.some(b => b.id === group.boxTypeId)) {
            group.boxTypeId = boxTypes.length > 0 ? boxTypes[0].id : '';
        }
    }
    renderBoxChips();
    populateStdBoxSelect();
    renderGroups();
    updateViewerSelect();
    const activeGroup = _getActiveMixedGroupForBoxApply();
    if (activeGroup && _lastViewerContext && _lastViewerContext.groupId === activeGroup.id) {
        _autoRefreshViewer(activeGroup.id);
    }
}

function _getActiveBoxTypeId() {
    const group = _getActiveMixedGroupForBoxApply();
    return group ? group.boxTypeId : '';
}

function _getActiveMixedGroupForBoxApply() {
    const select = document.getElementById('viewerSelect');
    const selected = select && select.value ? select.value.split('|')[0] : '';
    if (selected) {
        const group = mixedGroups.find(g => g.id === selected);
        if (group) return group;
    }
    if (_lastViewerContext && _lastViewerContext.groupId) {
        const group = mixedGroups.find(g => g.id === _lastViewerContext.groupId);
        if (group) return group;
    }
    return mixedGroups.length > 0 ? mixedGroups[0] : null;
}

function useBoxTypeForActiveGroup(boxId) {
    updateDataFromTables();
    const box = boxTypes.find(b => b.id === boxId);
    if (!box) return;
    const group = _getActiveMixedGroupForBoxApply();
    if (!group) {
        alert('请先创建混装组，再选择箱型使用');
        return;
    }
    group.boxTypeId = box.id;
    _invalidateViewerPreviewForGroup(group.id);
    renderGroups();
    updateViewerSelect();
    renderBoxChips();
    const select = document.getElementById('viewerSelect');
    if (select) select.value = `${group.id}|0`;
    viewGroup3D(group.id);
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
        addBoxRow({ name, length: String(size[0]), width: String(size[1]), height: String(size[2]), wall: CONFIG.defaultWallThickness }, { suppressSync: true });
        added.push(name);
    }
    if (added.length === 0) {
        alert('所有标准箱型已添加');
    } else {
        _syncBoxTypeDependents();
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
        fitMode: prefill?.fitMode || _autoPackingFitMode || 'strict',
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
        if (boxType) _repairBoxTypeDimensions(boxType);
        const boxName = boxType ? `${boxType.name} (${formatDims(boxType.external)})` : '未选择箱型';
        const internalStr = boxType ? formatDims(boxType.internal) : '—';

        // 验证
        const result = boxType ? _getLayoutResult(group, boxType) : null;
        const boxRecommendation = boxType ? _findBetterListedBoxRecommendation(group, boxType, result) : null;
        const displayGroupName = _getGroupDisplayName(group, boxType, result);
        const groupWeight = calcGroupWeight(group, skus);
        const fitLabel = result && result.fitMode === 'min-overflow-soft'
            ? '软包塑形通过'
            : result && result.verifiedFit ? '验证通过'
                : result && result.estimatedFit ? '估算通过'
                    : '无法装下';
        const fitIcon = result && result.fitMode === 'min-overflow-soft'
            ? '🟢'
            : result && result.verifiedFit ? '✅'
                : result && result.estimatedFit ? '⚠️'
                    : '❌';

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
                <span class="card-title">📦 ${displayGroupName}</span>
                <div style="display:flex;gap:6px;">
                    <button class="btn btn-sm btn-outline" onclick="editGroup('${group.id}')">编辑</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteGroup('${group.id}')">删除</button>
                </div>
            </div>
            <div class="form-row" style="margin-bottom:12px;">
                <div class="form-group">
                    <label>箱型</label>
                    <input class="group-box-search" type="search"
                        placeholder="搜索外箱长/尺寸，如 35、40×30"
                        value="${_escapeReplenishmentHtml(_groupBoxSearchQueries[group.id] || '')}"
                        oninput="updateGroupBoxSearch('${group.id}', this.value)">
                    <select class="group-box-select" onchange="updateGroupBoxType('${group.id}', this.value)" ${_getGroupBoxFilteredOptions(group).length === 0 ? 'disabled' : ''}>
                        ${_renderGroupBoxOptions(group)}
                    </select>
                    <span class="form-hint group-box-search-count">${_groupBoxSearchQueries[group.id] ? `匹配 ${_getGroupBoxFilteredOptions(group).length}/${boxTypes.length} 个箱型` : `共 ${boxTypes.length} 个箱型`}</span>
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
                <div class="form-group">
                    <label>重量</label>
                    <div style="padding:8px 0;font-size:13px;color:#475569;">
                        单箱 ${formatWeightKg(groupWeight.perBox)} / 总 ${formatWeightKg(groupWeight.total)}
                    </div>
                </div>
            </div>
            <table class="group-sku-table">
                <thead><tr>
                    <th>SKU</th>
                    <th>包装</th>
                    <th>公差</th>
                    <th>尺寸 (cm)</th>
                    <th>单件重量</th>
                    <th style="width:100px;">每箱数量</th>
                    <th>单箱重量</th>
                    <th>总计</th>
                    <th>总重量</th>
                    <th>剩余</th>
                    <th></th>
                </tr></thead>
                <tbody>
                    ${group.assignments.map((asgn, idx) => {
                        const sku = skus.find(s => s.id === asgn.skuId);
                        if (!sku) return '';
                        const used = asgn.qtyPerBox * group.boxCount;
                        const rem = Math.max(0, sku.quantity - used);
                        const unitWeight = Number(sku.unitWeight) || 0;
                        const perBoxWeight = unitWeight * asgn.qtyPerBox;
                        const totalWeight = unitWeight * used;
                        return `<tr>
                            <td><strong>${sku.name}</strong></td>
                            <td>${sku.packagingType === 'soft' ? '软' : '硬'}</td>
                            <td>${sku.packagingType === 'soft' ? (sku.softTolerance * 100).toFixed(0) + '%' : '—'}</td>
                            <td>${formatDims(sku.dimensions)}</td>
                            <td>${formatWeightKg(unitWeight)}</td>
                            <td><input type="number" min="0" class="qty-input" value="${asgn.qtyPerBox}" onchange="updateAssignmentQty('${group.id}', ${idx}, this.value)"></td>
                            <td>${formatWeightKg(perBoxWeight)}</td>
                            <td>${used}</td>
                            <td>${formatWeightKg(totalWeight)}</td>
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
                    ${fitIcon}
                    ${fitLabel}
                    — ${result.message}
                    ${!result.impossible ? ` | 利用率 ${(result.volumeUtilization * 100).toFixed(1)}%` : ''}
                    ${result.minOverflowRejectedReason ? ` | ${result.minOverflowRejectedReason}` : ''}
                    <button class="btn btn-sm btn-outline" style="margin-left:8px;" onclick="viewGroup3D('${group.id}')">3D 查看</button>
                </div>
            ` : ''}
            ${boxRecommendation ? _renderBetterBoxRecommendation(group, boxRecommendation) : ''}
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

function _formatBoxTypeOptionLabel(box) {
    return box ? `${box.name} (${formatDims(box.external)})` : '';
}

function _parseBoxSearchTokens(query) {
    return String(query || '')
        .replace(/[×x*，,;；/\\|]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

function _boxMatchesSearch(box, query) {
    if (!box || !box.external) return false;
    const raw = String(query || '').trim().toLowerCase();
    if (!raw) return true;
    const tokens = _parseBoxSearchTokens(raw);
    if (tokens.length === 0) return true;

    const dimsArr = [box.external.length, box.external.width, box.external.height];
    const lengthText = String(box.external.length);
    const fullText = `${box.name || ''} ${formatDims(box.external)} ${dimsArr.join(' ')}`.toLowerCase();

    // 单个数字优先按“外箱长”筛选；这样输入 35 会先找到长为 35cm 的箱型。
    if (tokens.length === 1) {
        const num = parseFloat(tokens[0]);
        if (Number.isFinite(num)) {
            return Math.abs(box.external.length - num) < 0.05 || lengthText.startsWith(tokens[0]);
        }
        return fullText.includes(tokens[0]);
    }

    // 多个数字用于快速匹配尺寸组合，如 35 25 或 35×35×25。
    return tokens.every(token => fullText.includes(token));
}

function _getGroupBoxFilteredOptions(group) {
    const query = _groupBoxSearchQueries[group.id] || '';
    const matched = boxTypes.filter(bt => _boxMatchesSearch(bt, query));
    const current = boxTypes.find(bt => bt.id === group.boxTypeId);
    if (current && !matched.some(bt => bt.id === current.id)) {
        return [current, ...matched];
    }
    return matched;
}

function _renderGroupBoxOptions(group) {
    const options = _getGroupBoxFilteredOptions(group);
    if (options.length === 0) {
        return '<option value="">没有匹配箱型</option>';
    }
    return options.map(bt =>
        `<option value="${bt.id}" ${bt.id === group.boxTypeId ? 'selected' : ''}>${_escapeReplenishmentHtml(_formatBoxTypeOptionLabel(bt))}</option>`
    ).join('');
}

function updateGroupBoxSearch(groupId, query) {
    _groupBoxSearchQueries[groupId] = query || '';
    const group = mixedGroups.find(g => g.id === groupId);
    if (!group) return;
    const card = document.querySelector(`#groupsContainer .card[data-group-id="${groupId}"]`);
    const select = card ? card.querySelector('.group-box-select') : null;
    const count = card ? card.querySelector('.group-box-search-count') : null;
    const options = _getGroupBoxFilteredOptions(group);
    if (select) {
        select.innerHTML = options.length > 0
            ? options.map(bt => `<option value="${bt.id}" ${bt.id === group.boxTypeId ? 'selected' : ''}>${_escapeReplenishmentHtml(_formatBoxTypeOptionLabel(bt))}</option>`).join('')
            : '<option value="">没有匹配箱型</option>';
        select.disabled = options.length === 0;
    }
    if (count) {
        const total = boxTypes.length;
        count.textContent = query ? `匹配 ${options.length}/${total} 个箱型` : `共 ${total} 个箱型`;
    }
}

// ---- 混装组操作 ----

function updateGroupBoxType(groupId, boxTypeId) {
    const group = mixedGroups.find(g => g.id === groupId);
    if (group && boxTypeId) {
        group.boxTypeId = boxTypeId;
        _invalidateViewerPreviewForGroup(groupId);
        renderGroups();
        renderBoxChips();
        updateViewerSelect();
        if (!_autoRefreshViewer(groupId)) {
            viewGroup3D(groupId, { scroll: false });
        }
    }
}

function updateGroupBoxCount(groupId, val) {
    const group = mixedGroups.find(g => g.id === groupId);
    if (group) {
        group.boxCount = parseInt(val) || CONFIG.defaultMinBoxes;
        _invalidateViewerPreviewForGroup(groupId);
        renderGroups();
        renderBoxChips();
        updateViewerSelect();
        _autoRefreshViewer(groupId);
    }
}

function updateGroupFitMode(groupId, mode) {
    const group = mixedGroups.find(g => g.id === groupId);
    if (group) {
        group.fitMode = mode === 'minOverflow' ? 'minOverflow' : 'strict';
        _invalidateViewerPreviewForGroup(groupId);
        renderGroups();
        updateViewerSelect();
        if (!_autoRefreshViewer(groupId)) {
            viewGroup3D(groupId, { scroll: false });
        }
    }
}

function updateAutoPackingFitMode(mode, syncExisting) {
    if (syncExisting == null) syncExisting = true;
    _autoPackingFitMode = mode === 'minOverflow' ? 'minOverflow' : 'strict';
    const select = document.getElementById('autoPackingFitMode');
    if (select && select.value !== _autoPackingFitMode) select.value = _autoPackingFitMode;
    if (syncExisting && mixedGroups.length > 0) {
        for (const group of mixedGroups) {
            group.fitMode = _autoPackingFitMode;
            _invalidateViewerPreviewForGroup(group.id);
        }
        renderGroups();
        updateViewerSelect();
        if (_lastViewerContext) _autoRefreshViewer(_lastViewerContext.groupId);
    }
}

function _getAutoPackingFitMode() {
    const select = document.getElementById('autoPackingFitMode');
    if (select) updateAutoPackingFitMode(select.value, false);
    return _autoPackingFitMode || 'strict';
}

function _showFirstMixedGroup3D() {
    if (!mixedGroups || mixedGroups.length === 0) return;
    updateViewerSelect();
    viewGroup3D(mixedGroups[0].id, { scroll: false });
}

function updateAssignmentQty(groupId, idx, val) {
    const group = mixedGroups.find(g => g.id === groupId);
    if (group && group.assignments[idx]) {
        group.assignments[idx].qtyPerBox = Math.max(0, parseInt(val) || 0);
        _invalidateViewerPreviewForGroup(groupId);
        renderGroups();
        renderBoxChips();
        updateViewerSelect();
        _autoRefreshViewer(groupId);
    }
}

function _invalidateViewerPreviewForGroup(groupId) {
    if (_lastViewerBasePayload?.group?.id === groupId) _lastViewerBasePayload = null;
    if (_lastViewerPreviewPayload?.group?.id === groupId) _lastViewerPreviewPayload = null;
    if (_lastReplenishmentPlan?.groupId === groupId) {
        _lastReplenishmentPlan = null;
        _lastBoxReplenishmentAlternatives = [];
    }
    if (_lastViewerContext?.groupId === groupId) {
        _viewerDisplayMode = 'real';
        _syncViewerModeButtons();
    }
    if (typeof window.clearReplenishmentOverlay === 'function') window.clearReplenishmentOverlay();
}

/** 如果3D查看器正在显示该组，自动刷新 */
function _autoRefreshViewer(groupId) {
    if (!_lastViewerContext || _lastViewerContext.groupId !== groupId) return false;
    const select = document.getElementById('viewerSelect');
    if (!select) return false;
    let optVal = groupId + '|' + _lastViewerContext.boxIdx;
    let opt = select.querySelector('option[value="' + optVal + '"]');
    if (!opt) {
        optVal = groupId + '|0';
        opt = select.querySelector('option[value="' + optVal + '"]');
    }
    if (!opt) return false;
    select.value = optVal;
    refreshViewer();
    return true;
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
    const totalWeight = skus.reduce((s, sku) => s + (Number(sku.unitWeight) || 0) * (Number(sku.quantity) || 0), 0);
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
        <div class="summary-item"><div class="summary-value">${formatWeightKg(totalWeight)}</div><div class="summary-label">总重量</div></div>
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

function viewGroup3D(groupId, options) {
    options = options || {};
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

    _renderViewerPayload(_makeViewerPayload(group, boxType, result, 0, result.cavities), false);
    if (options.scroll !== false) {
        const viewerSection = document.getElementById('viewerSection') || document.getElementById('resultsSection');
        if (viewerSection) viewerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function _renderBetterBoxRecommendation(group, rec) {
    const savings = Math.max(0, rec.volumeSavingRatio * 100).toFixed(0);
    const util = (rec.utilization * 100).toFixed(1);
    const currentUtil = Number.isFinite(rec.currentUtilization) ? (rec.currentUtilization * 100).toFixed(1) : '--';
    return `
        <div class="box-recommendation">
            <div class="box-recommendation-main">
                <strong>系统推荐更合适的已有箱型：</strong>
                <span>${formatDims(rec.box.external)} cm</span>
                <em>当前 ${currentUtil}% → 推荐 ${util}%，箱体约小 ${savings}%</em>
            </div>
            <div class="box-recommendation-actions">
                <button class="btn btn-sm btn-primary" onclick="applyBetterListedBox('${group.id}')">应用并查看3D</button>
            </div>
        </div>
    `;
}

function applyBetterListedBox(groupId) {
    updateDataFromTables();
    const group = mixedGroups.find(g => g.id === groupId);
    if (!group) return;
    const currentBox = boxTypes.find(b => b.id === group.boxTypeId);
    if (!currentBox) return;
    const currentResult = validateMixedGroup(group, skus, currentBox.internal);
    const rec = _findBetterListedBoxRecommendation(group, currentBox, currentResult);
    if (!rec) {
        alert('当前列表里没有比现有箱型更合适的箱型');
        return;
    }
    const appliedBox = _ensureAutoBoxType(rec.box);
    group.boxTypeId = appliedBox.id;
    renderGroups();
    updateViewerSelect();
    renderBoxChips();
    viewGroup3D(group.id);
}

function _repairBoxTypeDimensions(box) {
    if (!box || !box.external) return box;
    const wall = box.wallThickness || CONFIG.defaultWallThickness;
    const expected = dims(
        Math.max(0.1, box.external.length - wall * 2),
        Math.max(0.1, box.external.width - wall * 2),
        Math.max(0.1, box.external.height - wall * 2)
    );
    const invalid = !box.internal ||
        box.internal.length > box.external.length + 0.01 ||
        box.internal.width > box.external.width + 0.01 ||
        box.internal.height > box.external.height + 0.01 ||
        (box.autoGenerated && (
            Math.abs(box.internal.length - expected.length) > 0.05 ||
            Math.abs(box.internal.width - expected.width) > 0.05 ||
            Math.abs(box.internal.height - expected.height) > 0.05
        ));
    if (invalid) box.internal = expected;
    return box;
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
            const displayGroupName = _getGroupDisplayName(group, boxType, result);
            opt.textContent = `${badge} ${displayGroupName} — 箱 #${i + 1} (${placed}/${total}件)${algoTag}`;
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
        if (!group) return;
        const boxType = boxTypes.find(b => b.id === group.boxTypeId);
        if (!boxType) return;

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
                    _renderViewerPayload(_makeViewerPayload(group, boxType, oldResult, parseInt(boxIdx)), false);
                    return;
                }
            }
            // 无可用布局
            const c = document.getElementById('viewer-container');
            if (c) c.innerHTML = '<div class="viewer-empty">此箱子组合无可用布局</div>';
            return;
        }

        _renderViewerPayload(_makeViewerPayload(group, boxType, result, parseInt(boxIdx), result.cavities), false);
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
    _lastBoxReplenishmentAlternatives = [];
    _lastViewerPreviewPayload = null;
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
    if (!group) return;
    const boxType = boxTypes.find(b => b.id === group.boxTypeId);
    if (!boxType) return;

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
    const perBoxFloor = Math.floor(qty / n);
    if (perBoxFloor > 0) {
        const alloc = perBoxFloor * n;
        candidates.push({ qtyPerBox: perBoxFloor, allocated: alloc, remainder: Math.max(0, qty - alloc) });
    }

    // Strategy 2: ceil-based（略超量，但浪费<1个时不放弃）
    const perBoxCeil = Math.ceil(qty / n);
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
 * 从候选方案列表中验证可行方案。5箱完整装完是最高优先级，其次才比较利用率和紧凑度。
 */
function _validateAndPickBest(candidates, allSkus, fitMode) {
    fitMode = fitMode || _autoPackingFitMode || 'strict';
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    let best = null;
    let checked = 0;
    for (const cand of candidates) {
        const layout = _validateAutoCandidate(cand, allSkus, fitMode);
        if (layout) {
            cand.layout = layout;
            cand.score = _scoreAutoFilledCandidate(cand, allSkus);
            if (!best || cand.score > best.score) best = cand;
            checked++;
            if (checked >= 600 && best) break;
        }
    }
    return best;
}

function _validateAutoCandidate(cand, allSkus, fitMode) {
    fitMode = fitMode || cand.fitMode || _autoPackingFitMode || 'strict';
    if (!cand || !cand.bt || !cand.assignments || cand.assignments.length === 0) return null;
    const tempGroup = {
        id: 'auto_test',
        name: 'auto_test',
        boxTypeId: cand.bt.id,
        boxCount: cand.n,
        fitMode,
        assignments: cand.assignments,
    };
    try {
        const rawLayout = generateMixedLayout(tempGroup, allSkus, cand.bt.internal);
        const layout = fitMode === 'minOverflow'
            ? _applyMinOverflowSoftFit(tempGroup, cand.bt, rawLayout)
            : rawLayout;
        if (!_isAutoLayoutAccepted(layout, cand.assignments, fitMode)) return null;
        return layout;
    } catch (e) {
        return null;
    }
}

function _isAutoLayoutComplete(layout, assignments) {
    if (!layout || layout.impossible || !layout.verifiedFit) return false;
    if (layout.overflowItems && layout.overflowItems.length > 0) return false;
    const expected = (assignments || []).reduce((s, a) => s + (a.qtyPerBox || 0), 0);
    const placed = _countLayoutPlacedItems(layout);
    return placed >= expected;
}

function _isAutoLayoutAccepted(layout, assignments, fitMode) {
    if (!layout) return false;
    if (fitMode !== 'minOverflow') return _isAutoLayoutComplete(layout, assignments);
    if (layout.impossible && layout.fitMode !== 'min-overflow-soft') return false;
    if (layout.overflowItems && layout.overflowItems.length > 0) return false;
    if (!layout.verifiedFit && layout.fitMode !== 'min-overflow-soft') return false;
    const expected = (assignments || []).reduce((s, a) => s + (a.qtyPerBox || 0), 0);
    const placed = _countLayoutPlacedItems(layout);
    const absorbed = (layout.compressedPlacements || []).length;
    return placed + absorbed >= expected;
}

function _countLayoutPlacedItems(layout) {
    let count = 0;
    for (const layer of layout.layers || []) {
        count += (layer.placements || []).length;
        count += (layer.stacks || []).length;
    }
    return count;
}

function _getAutoBoxPool(includeGenerated) {
    const pool = [];
    const seen = new Set();
    const addBox = (box) => {
        if (!box || !box.external) return;
        const key = [box.external.length, box.external.width, box.external.height]
            .map(v => Number(v).toFixed(1)).sort().join('x');
        if (seen.has(key)) return;
        seen.add(key);
        pool.push(box);
    };

    for (const box of boxTypes) addBox(box);
    return pool;
}

function _getListedBoxRecommendationPool() {
    const boxes = [];
    const seen = new Set();
    for (const box of boxTypes || []) {
        if (!box || !box.external || !box.internal) continue;
        _repairBoxTypeDimensions(box);
        const key = [box.external.length, box.external.width, box.external.height]
            .map(v => Number(v).toFixed(1)).sort().join('x');
        if (seen.has(key)) continue;
        seen.add(key);
        boxes.push(box);
    }
    return boxes;
}

function _findBetterListedBoxRecommendation(group, currentBox, currentResult) {
    if (!group || !currentBox || !currentBox.external || !currentBox.internal) return null;
    if (!group.assignments || group.assignments.length === 0) return null;
    _repairBoxTypeDimensions(currentBox);
    const currentExternalVol = dimsVolume(currentBox.external);
    const currentUtilization = currentResult && !currentResult.impossible
        ? currentResult.volumeUtilization
        : 0;
    const currentQuality = _layoutQualityMetrics(currentResult);
    const candidates = _getListedBoxRecommendationPool();
    let best = null;

    for (const box of candidates) {
        if (_sameDims(box.external, currentBox.external)) continue;
        const externalVol = dimsVolume(box.external);
        if (externalVol >= currentExternalVol * 0.985) continue;

        const tempGroup = {
            id: group.id,
            name: group.name,
            boxTypeId: box.id,
            boxCount: group.boxCount,
            assignments: group.assignments.map(a => ({ skuId: a.skuId, qtyPerBox: a.qtyPerBox })),
        };

        let layout;
        try {
            layout = generateMixedLayout(tempGroup, skus, box.internal);
        } catch (e) {
            continue;
        }
        if (!_isAutoLayoutComplete(layout, tempGroup.assignments)) continue;
        const utilization = layout.volumeUtilization || 0;
        const volumeSavingRatio = 1 - externalVol / currentExternalVol;
        if (volumeSavingRatio < 0.03) continue;
        const quality = _layoutQualityMetrics(layout);
        if (currentQuality.totalItems > 0) {
            if (quality.bottomLayerRatio < currentQuality.bottomLayerRatio - 0.08) continue;
            if (quality.usedHeight > currentQuality.usedHeight + 0.5 && volumeSavingRatio < 0.30) continue;
            if (quality.layerCount > currentQuality.layerCount + 1 && volumeSavingRatio < 0.30) continue;
            if (quality.heightFillRatio < currentQuality.heightFillRatio - 0.12 && volumeSavingRatio < 0.35) continue;
        }
        const topEmpty = quality.boxHeight > 0 ? Math.max(0, quality.boxHeight - quality.usedHeight) : 0;
        if (topEmpty > 6 && utilization < Math.max(0.70, currentUtilization + 0.04)) continue;
        if (quality.heightFillRatio > 0 && quality.heightFillRatio < 0.68 && utilization < 0.78) continue;

        const score = volumeSavingRatio * 1000 +
            utilization * 600 -
            Math.max(0, topEmpty - 3) * 80 +
            quality.heightFillRatio * 350 -
            Math.max(0, currentQuality.bottomLayerRatio - quality.bottomLayerRatio) * 900 -
            Math.max(0, quality.usedHeight - currentQuality.usedHeight) * 16 -
            Math.max(0, 0.52 - utilization) * 400 -
            externalVol / 500000;
        const rec = {
            box,
            layout,
            utilization,
            currentUtilization,
            volumeSavingRatio,
            quality,
            score,
        };
        if (!best || rec.score > best.score) best = rec;
    }
    return best;
}

function _layoutQualityMetrics(layout) {
    const layers = (layout && layout.layers) || [];
    let totalItems = 0;
    let firstLayerItems = 0;
    let usedHeight = 0;
    let boxHeight = 0;
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        const layerItems = (layer.placements || []).length + (layer.stacks || []).length;
        totalItems += layerItems;
        if (i === 0) firstLayerItems = layerItems;
        if (layer.boxOrientation && Number.isFinite(layer.boxOrientation.height)) {
            boxHeight = Math.max(boxHeight, layer.boxOrientation.height);
        }
        usedHeight = Math.max(usedHeight, (layer.yOffset || 0) + (layer.height || 0));
        for (const s of layer.stacks || []) {
            usedHeight = Math.max(usedHeight, (layer.yOffset || 0) + (s.stackBase || 0) + (s.height || 0));
        }
    }
    return {
        totalItems,
        layerCount: layers.length,
        firstLayerItems,
        bottomLayerRatio: totalItems > 0 ? firstLayerItems / totalItems : 0,
        usedHeight,
        boxHeight,
        heightFillRatio: boxHeight > 0 ? Math.min(1, usedHeight / boxHeight) : 0,
    };
}

function _sameDims(a, b) {
    if (!a || !b) return false;
    const aa = [a.length, a.width, a.height].map(Number).sort((x, y) => y - x);
    const bb = [b.length, b.width, b.height].map(Number).sort((x, y) => y - x);
    return aa.every((v, i) => Math.abs(v - bb[i]) < 0.05);
}

function _isNoLargerBySortedSides(candidate, current) {
    if (!candidate || !current) return false;
    const c = [candidate.length, candidate.width, candidate.height].map(Number).sort((a, b) => b - a);
    const cur = [current.length, current.width, current.height].map(Number).sort((a, b) => b - a);
    return c.every((v, i) => v <= cur[i] + 0.05);
}

function _ensureAutoBoxType(box) {
    if (!box) return box;
    const existing = boxTypes.find(b =>
        _sameDims(b.external, box.external) &&
        Math.abs((b.wallThickness || CONFIG.defaultWallThickness) - (box.wallThickness || CONFIG.defaultWallThickness)) < 0.05
    );
    if (existing) return existing;
    const clone = {
        id: genBoxId(),
        name: box.name || `推荐常规 ${formatDims(box.external)}`,
        external: dimsClone(box.external),
        wallThickness: box.wallThickness || CONFIG.defaultWallThickness,
        internal: dimsClone(box.internal),
        autoGenerated: true,
    };
    boxTypes.push(clone);
    renderBoxChips();
    populateStdBoxSelect();
    return clone;
}

function _calcAllocatedQty(assignments, n, allSkus) {
    let total = 0;
    for (const a of assignments || []) {
        const sku = allSkus.find(s => s.id === a.skuId);
        if (!sku) continue;
        total += Math.min(sku.quantity, (a.qtyPerBox || 0) * n);
    }
    return total;
}

function _scoreAutoFilledCandidate(cand, allSkus) {
    const totalQty = allSkus.reduce((s, sku) => s + sku.quantity, 0);
    const allocated = _calcAllocatedQty(cand.assignments, cand.n, allSkus);
    const allocatedRatio = totalQty > 0 ? allocated / totalQty : 0;
    const totalRemainder = _calcRemainder(cand.assignments || [], cand.n || 1, allSkus);
    const completeAll = totalRemainder === 0;
    const targetBoxes = CONFIG.defaultMinBoxes || 5;
    const externalVol = dimsVolume(cand.bt.external || cand.bt.internal);
    const hardAllocated = cand.hardAllocated || 0;
    const hardTotal = cand.hardTotal || 0;
    const hardRatio = hardTotal > 0 ? hardAllocated / hardTotal : 1;
    const quality = _layoutQualityMetrics(cand.layout);
    const boxHeight = quality.boxHeight || (cand.bt.internal && cand.bt.internal.height) || 0;
    const heightFillRatio = quality.heightFillRatio || 0;
    const topEmpty = boxHeight > 0 ? Math.max(0, boxHeight - quality.usedHeight) : 0;
    const compactnessBonus = cand.layout
        ? heightFillRatio * 900 - Math.max(0, topEmpty - 3) * 120 - Math.max(0, 0.72 - heightFillRatio) * 900
        : 0;
    return allocatedRatio * 10000
        + (completeAll ? 20000 : 0)
        + (completeAll && cand.n === targetBoxes ? 50000 : 0)
        + (!completeAll && cand.n === targetBoxes ? 1000 : 0)
        + Math.min(cand.volUtil || 0, 0.98) * 1600
        + compactnessBonus
        + hardRatio * 500
        - externalVol / 12000
        - Math.max(0, cand.n - targetBoxes) * 3500
        - Math.max(0, cand.n - 12) * 80
        - totalRemainder * 35
        - (cand.remainder || 0) * 12;
}

function _maximizeFillersForCandidate(baseCand, fillerSkus, allSkus, fitMode) {
    if (!baseCand) return null;
    fitMode = fitMode || _autoPackingFitMode || 'strict';
    const n = baseCand.n;
    const assignments = baseCand.assignments.map(a => ({ skuId: a.skuId, qtyPerBox: a.qtyPerBox }));
    const fillerById = {};
    for (const s of fillerSkus) fillerById[s.id] = s;

    const maxPerBox = {};
    for (const sku of fillerSkus) {
        maxPerBox[sku.id] = Math.max(0, Math.floor(sku.quantity / n));
    }

    let currentLayout = _validateAutoCandidate({ ...baseCand, assignments, fitMode }, allSkus, fitMode);
    if (!currentLayout) return null;

    while (true) {
        let bestStep = null;
        for (const sku of fillerSkus) {
            const cur = assignments.find(a => a.skuId === sku.id);
            const curQty = cur ? cur.qtyPerBox : 0;
            if (curQty >= maxPerBox[sku.id]) continue;

            const testAssignments = assignments.map(a => ({ ...a }));
            const target = testAssignments.find(a => a.skuId === sku.id);
            if (target) target.qtyPerBox += 1;
            else testAssignments.push({ skuId: sku.id, qtyPerBox: 1 });

            const testCand = { ...baseCand, assignments: testAssignments, fitMode };
            const layout = _validateAutoCandidate(testCand, allSkus, fitMode);
            if (!layout) continue;

            const addedVol = dimsVolume(getEffectiveDimensions(sku));
            const hardBonus = sku.packagingType === 'hard' ? 60 : 0;
            const softBonus = sku.packagingType === 'soft' ? 80 : 0;
            const score = addedVol + hardBonus + softBonus + (sku.quantity - (curQty + 1) * n >= 0 ? 100 : 0);
            if (!bestStep || score > bestStep.score) {
                bestStep = { sku, assignments: testAssignments, layout, score };
            }
        }
        if (!bestStep) break;
        assignments.splice(0, assignments.length, ...bestStep.assignments);
        currentLayout = bestStep.layout;
    }

    const productVol = assignments.reduce((sum, a) => {
        const sku = allSkus.find(s => s.id === a.skuId);
        return sum + (sku ? a.qtyPerBox * dimsVolume(getEffectiveDimensions(sku)) : 0);
    }, 0);
    const hardAllocated = assignments.reduce((sum, a) => {
        const sku = fillerById[a.skuId];
        return sum + (sku && sku.packagingType === 'hard' ? Math.min(sku.quantity, a.qtyPerBox * n) : 0);
    }, 0);
    const hardTotal = fillerSkus.filter(s => s.packagingType === 'hard').reduce((s, sku) => s + sku.quantity, 0);
    const remainder = _calcRemainder(assignments, n, allSkus);

    const result = {
        ...baseCand,
        assignments,
        layout: currentLayout,
        volUtil: productVol / dimsVolume(baseCand.bt.internal),
        remainder,
        hardAllocated,
        hardTotal,
    };
    result.score = _scoreAutoFilledCandidate(result, allSkus);
    return result;
}

function _pickBestAutoFilledCandidate(baseCandidates, fillerSkus, allSkus, fitMode) {
    fitMode = fitMode || _autoPackingFitMode || 'strict';
    const sorted = [...baseCandidates].sort((a, b) => b.score - a.score).slice(0, 220);
    let best = null;
    for (const baseCand of sorted) {
        const filled = _maximizeFillersForCandidate(baseCand, fillerSkus, allSkus, fitMode);
        if (!filled) continue;
        if (!best || filled.score > best.score) best = filled;
    }
    return best;
}

function _buildRemainingSkusAfterAssignments(assignments, n, allSkus) {
    return allSkus.map(sku => {
        const asgn = (assignments || []).find(a => a.skuId === sku.id);
        const used = asgn ? Math.min(sku.quantity, asgn.qtyPerBox * n) : 0;
        const remaining = Math.max(0, sku.quantity - used);
        if (remaining <= 0) return null;
        return {
            ...sku,
            quantity: remaining,
            dimensions: dimsClone(sku.dimensions),
        };
    }).filter(Boolean);
}

/**
 * 计算所有SKU在分配后的剩余数量总和（封顶）
 */
function _calcRemainder(assignments, n, allSkus) {
    const assignmentMap = {};
    for (const a of assignments || []) assignmentMap[a.skuId] = a;
    let rem = 0;
    for (const sku of allSkus || []) {
        if (!sku) continue;
        const a = assignmentMap[sku.id];
        const used = a ? Math.min(sku.quantity, (a.qtyPerBox || 0) * n) : 0;
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
            const targetBoxes = CONFIG.defaultMinBoxes || 5;
            if (remainder === 0) {
                score += 100 + (n === targetBoxes ? 1000 : 0) - Math.max(0, n - targetBoxes) * 10;
            } else {
                score += (n === targetBoxes ? 20 : 0) - remainRatio * 80 - Math.max(0, n - targetBoxes) * 2;
            }

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
    const fitMode = _getAutoPackingFitMode();

    const hasHard = skus.some(s => s.packagingType === 'hard');
    const hasSoft = skus.some(s => s.packagingType === 'soft');
    const hardSkus = skus.filter(s => s.packagingType === 'hard');
    const softSkus = skus.filter(s => s.packagingType === 'soft');

    // ───────────────────────────────────────────
    // 情况1：纯硬包装 或 纯软包装 → 单阶段
    // ───────────────────────────────────────────
    if (!hasHard || !hasSoft) {
        const maxUtil = hasHard ? 0.85 : 0.90;
        const candidates = _generateCandidates(skus, _getAutoBoxPool(), skus, maxUtil);
        if (candidates.length === 0) {
            alert('无法找到合适的装箱方案，请检查产品尺寸是否过大');
            return;
        }
        const best = _validateAndPickBest(candidates, skus, fitMode);
        if (!best) {
            alert(fitMode === 'minOverflow'
                ? '无法找到可被真实摆放或软包塑形吸收的自动装箱方案，请尝试更大箱型或减少每箱数量'
                : '无法找到可完整装入箱内的自动装箱方案，请尝试更大箱型或减少每箱数量');
            return;
        }
        best.bt = _ensureAutoBoxType(best.bt);
        mixedGroups.push({
            id: genGroupId(),
            name: `自动混装 (${best.bt.name}, ${best.n}箱, 利用率${(best.volUtil*100).toFixed(0)}%)`,
            boxTypeId: best.bt.id,
            boxCount: best.n,
            fitMode,
            assignments: best.assignments,
        });
        renderGroups();
        _showFirstMixedGroup3D();
        document.getElementById('resultsSection').style.display = 'block';
        return;
    }

    // ───────────────────────────────────────────
    // 情况2：硬+软混合 → 先硬后软两阶段
    // ───────────────────────────────────────────

    const totalQty = skus.reduce((s, sk) => s + sk.quantity, 0);
    const autoBoxPool = _getAutoBoxPool();

    // Phase 1: 硬包装候选方案
    const hardCandidates = _generateCandidates(hardSkus, autoBoxPool, skus, 0.85);
    if (hardCandidates.length === 0) {
        // 硬包装没有合适方案 → 回退到全部SKU一起算
        const fallbackCandidates = _generateCandidates(skus, autoBoxPool, skus, 0.75);
        if (fallbackCandidates.length === 0) {
            alert('无法找到合适的装箱方案，请检查产品尺寸是否过大');
            return;
        }
        const best = _validateAndPickBest(fallbackCandidates, skus, fitMode);
        if (!best) {
            alert(fitMode === 'minOverflow'
                ? '无法找到可被真实摆放或软包塑形吸收的自动装箱方案，请尝试更大箱型或减少每箱数量'
                : '无法找到可完整装入箱内的自动装箱方案，请尝试更大箱型或减少每箱数量');
            return;
        }
        best.bt = _ensureAutoBoxType(best.bt);
        mixedGroups.push({
            id: genGroupId(),
            name: `自动混装 (${best.bt.name}, ${best.n}箱, 利用率${(best.volUtil*100).toFixed(0)}%)`,
            boxTypeId: best.bt.id,
            boxCount: best.n,
            fitMode,
            assignments: best.assignments,
        });
        renderGroups();
        _showFirstMixedGroup3D();
        document.getElementById('resultsSection').style.display = 'block';
        return;
    }

    // Phase 2: 所有可补 SKU 一起做增量填充，软包和小硬盒都参与。
    let bestMain = _pickBestAutoFilledCandidate(hardCandidates, skus, skus, fitMode);
    if (!bestMain) bestMain = _validateAndPickBest(hardCandidates, skus, fitMode);
    if (!bestMain) {
        alert('无法找到合适的装箱方案，请检查产品尺寸是否过大');
        return;
    }
    bestMain.bt = _ensureAutoBoxType(bestMain.bt);

    const mainAssignments = bestMain.assignments;
    const mainN = bestMain.n;
    const mainBt = bestMain.bt;
    const mainVolUtil = bestMain.volUtil;

    let mainGroupName = `自动混装 (${mainBt.name}, ${mainN}箱, 利用率${(mainVolUtil*100).toFixed(0)}%)`;
    const remainingAfterMain = _buildRemainingSkusAfterAssignments(mainAssignments, mainN, skus);
    if (remainingAfterMain.length > 0) {
        mainGroupName += `, 剩余` + remainingAfterMain.length + `种未填入`;
    }
    mixedGroups.push({
        id: genGroupId(),
        name: mainGroupName,
        boxTypeId: mainBt.id,
        boxCount: mainN,
        fitMode,
        assignments: mainAssignments,
    });

    // Phase 3: 如果还有剩余，不限软硬，再生成第二组兜底。
    if (remainingAfterMain.length > 0) {
        const leftoverCandidates = _generateCandidates(remainingAfterMain, autoBoxPool, skus, 0.90);
        const bestLeftover = _validateAndPickBest(leftoverCandidates, skus, fitMode);
        if (bestLeftover) {
            bestLeftover.bt = _ensureAutoBoxType(bestLeftover.bt);
            mixedGroups.push({
                id: genGroupId(),
                name: `自动混装-剩余产品 (${bestLeftover.bt.name}, ${bestLeftover.n}箱, 利用率${(bestLeftover.volUtil*100).toFixed(0)}%)`,
                boxTypeId: bestLeftover.bt.id,
                boxCount: bestLeftover.n,
                fitMode,
                assignments: bestLeftover.assignments,
            });
        }
    }

    renderGroups();
    _showFirstMixedGroup3D();
    document.getElementById('resultsSection').style.display = 'block';
}

// ===== 工具 =====

function formatDims(d) {
    if (!d) return '—';
    return `${d.length.toFixed(1)}×${d.width.toFixed(1)}×${d.height.toFixed(1)}`;
}

function formatWeightKg(weight) {
    const n = Number(weight) || 0;
    if (n <= 0) return '—';
    if (n < 1) return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + ' kg';
    return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + ' kg';
}

function calcGroupWeight(group, skuList) {
    let perBox = 0;
    for (const asgn of group.assignments || []) {
        const sku = skuList.find(s => s.id === asgn.skuId);
        if (!sku) continue;
        perBox += (Number(sku.unitWeight) || 0) * (Number(asgn.qtyPerBox) || 0);
    }
    return {
        perBox,
        total: perBox * (Number(group.boxCount) || 0),
    };
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
