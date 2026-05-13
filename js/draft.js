// ===== FBA 装箱优化工具 — 自动草稿保存 =====

var DRAFT_KEY = 'fba_draft';
var DRAFT_TTL = 60 * 60 * 1000; // 1 hour
var DRAFT_INTERVAL = 60000; // 60 seconds

// ── Draft Toast ──────────────────────────────────────

function showDraftToast(msg) {
    var container = document.getElementById('draftToastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'draftToastContainer';
        container.className = 'draft-toast-container';
        document.body.appendChild(container);
    }
    var toast = document.createElement('div');
    toast.className = 'draft-toast';
    toast.textContent = msg || '已保存临时记录';
    container.appendChild(toast);
    setTimeout(function () {
        toast.classList.add('draft-toast-hiding');
        toast.addEventListener('animationend', function () { toast.remove(); });
    }, 2000);
}

// ── Save Draft ───────────────────────────────────────

function saveDraft() {
    // Skip if no data
    if ((!skus || skus.length === 0) && document.querySelectorAll('#skuBody tr').length === 0) {
        return;
    }
    if (typeof updateDataFromTables === 'function') {
        updateDataFromTables();
    }
    var draft = {
        timestamp: Date.now(),
        skus: JSON.parse(JSON.stringify(skus)),
        boxTypes: JSON.parse(JSON.stringify(boxTypes)),
        mixedGroups: JSON.parse(JSON.stringify(mixedGroups)),
        nextSkuId: nextSkuId,
        nextBoxId: nextBoxId,
        nextGroupId: nextGroupId,
    };
    try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        showDraftToast('已保存临时记录');
    } catch (e) {
        // localStorage full or unavailable — silently ignore
    }
}

// ── Restore Draft ────────────────────────────────────

function restoreDraft() {
    var raw;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return false; }
    if (!raw) return false;

    var draft;
    try { draft = JSON.parse(raw); } catch (e) { return false; }
    if (!draft.skus || !draft.boxTypes) return false;

    // Check expiration
    if (Date.now() - draft.timestamp > DRAFT_TTL) {
        try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
        return false;
    }

    // Clear existing data
    document.querySelectorAll('#skuBody tr').forEach(function (tr) { tr.remove(); });
    boxTypes = [];
    mixedGroups = [];

    // Restore SKU rows
    for (var i = 0; i < draft.skus.length; i++) {
        var sku = draft.skus[i];
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

    // Build SKU ID map (old → new by name + dimensions)
    var skuIdMap = new Map();
    for (var s = 0; s < draft.skus.length; s++) {
        var oldSku = draft.skus[s];
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

    // Restore box types
    var boxIdMap = new Map();
    for (var b = 0; b < draft.boxTypes.length; b++) {
        var box = draft.boxTypes[b];
        var result = addBoxRow({
            name: box.name,
            length: String(box.external.length),
            width: String(box.external.width),
            height: String(box.external.height),
            wall: String(box.wallThickness || 1.0),
        });
        if (result) boxIdMap.set(box.id, result.id);
    }

    // Restore mixed groups with remapped IDs
    for (var g = 0; g < draft.mixedGroups.length; g++) {
        var group = draft.mixedGroups[g];
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

    // Update counters
    nextSkuId = draft.nextSkuId;
    nextBoxId = draft.nextBoxId;
    nextGroupId = draft.nextGroupId;

    // Show results section if there are groups
    if (draft.mixedGroups.length > 0) {
        var rs = document.getElementById('resultsSection');
        if (rs) rs.style.display = 'block';
        if (typeof updateViewerSelect === 'function') updateViewerSelect();
    }

    // Clear draft so next auto-save starts fresh
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    return true;
}

// ── Init ─────────────────────────────────────────────

function initDraft() {
    var restored = restoreDraft();
    if (restored) {
        setTimeout(function () { showDraftToast('已恢复上次编辑的临时记录'); }, 500);
    }
    setInterval(saveDraft, DRAFT_INTERVAL);
    window.addEventListener('beforeunload', function () {
        saveDraft();
    });
}

document.addEventListener('DOMContentLoaded', initDraft);
