// ===== 混装算法 =====
// 多种SKU混装一箱的可行性验证

/**
 * 验证混装组的装箱可行性
 * @param {Object} group - MixedGroup
 * @param {Array} skus - 所有SKU数据
 * @param {Object} boxInternal - {length, width, height} 箱内径(cm)
 * @returns {Object} PackingResult
 */
function validateMixedGroup(group, skus, boxInternal) {
    const skuMap = {};
    for (const s of skus) skuMap[s.id] = s;

    // 展开每箱内各SKU的有效尺寸和数量
    const items = [];
    for (const asgn of group.assignments) {
        const sku = skuMap[asgn.skuId];
        if (!sku) continue;
        const effDims = getEffectiveDimensions(sku);
        for (let i = 0; i < asgn.qtyPerBox; i++) {
            items.push({
                skuId: sku.id,
                skuName: sku.name,
                dims: effDims,
                originalDims: sku.dimensions,
                packagingType: sku.packagingType,
            });
        }
    }

    if (items.length === 0) {
        return makeResult(PACKING_STATUS.IMPOSSIBLE, 0, dimsVolume(boxInternal), 0, '没有产品可装');
    }

    const totalVol = items.reduce((sum, item) => sum + dimsVolume(item.dims), 0);
    const boxVol = dimsVolume(boxInternal);

    // Phase 1: 快速体积拒绝
    if (totalVol > boxVol) {
        return makeResult(PACKING_STATUS.IMPOSSIBLE, totalVol, boxVol, 0,
            `产品总体积(${totalVol.toFixed(0)}cm³)超过箱内容积(${boxVol.toFixed(0)}cm³)`);
    }

    // Phase 2: 层架算法（尝试完整排列）
    const levelResult = shelfLevelPacking(items, boxInternal, false);
    if (levelResult.success) {
        return makeResult(PACKING_STATUS.VERIFIED, totalVol, boxVol, totalVol / boxVol,
            '层架算法验证通过', levelResult.layers);
    }

    // Phase 3: 体积估算降级
    const packingType = classifyMixType(items);
    const factor = PACKING_FACTORS[packingType] || 0.65;
    const usableVol = boxVol * factor;

    if (totalVol <= usableVol) {
        return makeResult(PACKING_STATUS.ESTIMATED, totalVol, boxVol, totalVol / boxVol,
            `体积估算通过(填充系数${Math.round(factor * 100)}%)`);
    } else {
        return makeResult(PACKING_STATUS.IMPOSSIBLE, totalVol, boxVol, totalVol / boxVol,
            `超出估算容量：需${(totalVol / usableVol * 100).toFixed(0)}%`);
    }
}

/**
 * 生成用于3D可视化的布局数据（始终返回，即使不完全成功）
 * 验证通过了就用精确的层架数据，没通过就用部分排列数据
 */
function generateMixedLayout(group, skus, boxInternal) {
    const skuMap = {};
    for (const s of skus) skuMap[s.id] = s;

    const items = [];
    for (const asgn of group.assignments) {
        const sku = skuMap[asgn.skuId];
        if (!sku) continue;
        const effDims = getEffectiveDimensions(sku);
        for (let i = 0; i < asgn.qtyPerBox; i++) {
            items.push({
                skuId: sku.id,
                skuName: sku.name,
                dims: effDims,
                originalDims: sku.dimensions,
                packagingType: sku.packagingType,
            });
        }
    }

    if (items.length === 0) {
        return makeResult(PACKING_STATUS.IMPOSSIBLE, 0, dimsVolume(boxInternal), 0, '没有产品可装', []);
    }

    const totalVol = items.reduce((sum, item) => sum + dimsVolume(item.dims), 0);
    const boxVol = dimsVolume(boxInternal);

    let result;
    if (totalVol > boxVol) {
        const partial = shelfLevelPacking(items, boxInternal, true);
        result = makeResult(PACKING_STATUS.IMPOSSIBLE, totalVol, boxVol, 0,
            `产品总体积(${totalVol.toFixed(0)}cm³)超过箱内容积(${boxVol.toFixed(0)}cm³)`,
            partial.layers);
        result.overflowItems = partial.unplaced || (partial.layers.length === 0 ? items : []);
        return result;
    }

    const fullResult = shelfLevelPacking(items, boxInternal, false);
    if (fullResult.success) {
        result = makeResult(PACKING_STATUS.VERIFIED, totalVol, boxVol, totalVol / boxVol,
            '层架算法验证通过', fullResult.layers);
        result.overflowItems = [];
        return result;
    }

    const partial = shelfLevelPacking(items, boxInternal, true);
    const packingType = classifyMixType(items);
    const factor = PACKING_FACTORS[packingType] || 0.65;
    const usableVol = boxVol * factor;

    let status, msg;
    if (totalVol <= usableVol) {
        status = PACKING_STATUS.ESTIMATED;
        msg = `体积估算通过(填充系数${Math.round(factor * 100)}%) — 部分排列可视化`;
    } else {
        status = PACKING_STATUS.IMPOSSIBLE;
        msg = `超出估算容量 — 部分排列可视化`;
    }

    result = makeResult(status, totalVol, boxVol, totalVol / boxVol, msg, partial.layers);
    result.overflowItems = partial.unplaced || (partial.layers.length === 0 ? items : []);
    return result;
}

// ===== 层架算法 =====

function shelfLevelPacking(items, boxInternal, allowPartial) {
    // 按高度降序排列
    const sorted = [...items].sort((a, b) => b.dims.height - a.dims.height);

    // 尝试箱子的6种方向
    const boxDirs = generateOrientations(boxInternal);

    let bestPartial = null;
    let bestPlaced = -1;
    let bestBoxDir = null;

    for (const boxDir of boxDirs) {
        const result = tryShelfPack(sorted, boxDir);
        if (result.success) {
            result.layers.forEach(l => l.boxOrientation = boxDir);
            return result;
        }
        // 跟踪最佳部分排列
        if (allowPartial) {
            const placed = result.layers.reduce((s, l) => s + l.itemCount, 0);
            if (placed > bestPlaced) {
                bestPlaced = placed;
                bestPartial = result;
                bestBoxDir = boxDir;
            }
        }
    }

    if (allowPartial && bestPartial) {
        if (bestBoxDir) {
            bestPartial.layers.forEach(l => l.boxOrientation = bestBoxDir);
        }
        return bestPartial;
    }

    return { success: false, layers: [] };
}

function tryShelfPack(items, boxDir) {
    const floorL = boxDir.length;
    const floorW = boxDir.width;
    const maxH = boxDir.height;

    const layers = [];
    let usedHeight = 0;
    let finalUnplaced = [];
    let remaining = [...items];

    while (remaining.length > 0) {
        // 按体积降序排列（大件优先）
        remaining.sort((a, b) => dimsVolume(b.dims) - dimsVolume(a.dims));

        const remainingH = maxH - usedHeight;

        // 找"架长"：体积最大且能在某朝向下放入剩余高度的产品
        let curHeight = 0;
        let startIdx = -1;
        for (let i = 0; i < remaining.length; i++) {
            const orient = pickBestOrientation(remaining[i], remainingH);
            if (orient) {
                curHeight = orient.h;
                startIdx = i;
                break;
            }
        }
        if (startIdx === -1) {
            // 所有剩余产品都太高（所有朝向都不行）
            finalUnplaced.push(...remaining);
            break;
        }

        // startIdx 之前的产品体积更大但放不进剩余高度 -> 永久放弃
        for (let i = 0; i < startIdx; i++) {
            finalUnplaced.push(remaining[i]);
        }

        // 准备这一层的候选：从 startIdx 开始，每个产品选 ≤ curHeight 的最优朝向
        // 如果一个产品所有朝向都 > curHeight，它也永远放不进后续的层 -> 永久放弃
        const candidates = [];
        const laterItems = [];
        for (let i = startIdx; i < remaining.length; i++) {
            const orient = pickBestOrientation(remaining[i], curHeight);
            if (orient) {
                candidates.push({ item: remaining[i], l: orient.l, w: orient.w, h: orient.h });
            } else {
                laterItems.push(remaining[i]);
            }
        }
        if (candidates.length === 0) break;

        // 2D排布（带预计算朝向）
        const result = pack2DGuillotine(candidates, floorL, floorW);
        if (!result || result.placements.length === 0) break;

        const layer = {
            height: curHeight,
            yOffset: usedHeight,
            placements: result.placements,
            stacks: [],
            itemCount: result.placements.length,
        };

        // 缝隙填充：未排进 floor 的且高度 ≤ curHeight 的，
        // 尝试堆叠到矮产品上面的空气隙中
        let unstackable = result.unplaced || [];
        if (unstackable.length > 0) {
            const gapResult = tryGapFilling(layer, unstackable, curHeight);
            layer.stacks = gapResult.stacks;
            layer.itemCount += gapResult.stacks.length;
            unstackable = gapResult.remaining;
        }

        layers.push(layer);
        usedHeight += curHeight;

        // 没排进这一层的继续尝试下一层
        // laterItems: 高度超 curHeight 的（被 next shelf 砍掉一部分高度）
        // unstackable: 缝隙也塞不进的
        remaining = [...laterItems, ...unstackable];
    }

    return { success: finalUnplaced.length === 0, layers, unplaced: finalUnplaced };
}

// ===== 缝隙填充：矮产品上方堆叠 =====

/**
 * 在一层内，把未排进 floor 的小件堆叠到矮产品上面的空气隙中
 * @param {Object} layer - 当前层（placements已确定）
 * @param {Array} stackableItems - 还没排进去的产品
 * @param {number} shelfHeight - 层高
 * @returns {Object} {stacks, remaining}
 */
function tryGapFilling(layer, stackableItems, shelfHeight) {
    // 收集空气隙：floor 上每个产品，如果实际高度 < 层高，上方就是空隙
    const airSpaces = [];
    for (const p of layer.placements) {
        const itemH = p.height || shelfHeight;
        if (itemH < shelfHeight - 0.05) { // 至少 0.5mm 空隙
            airSpaces.push({
                x: p.x, z: p.y,               // 在地板上的2D位置
                l: p.length, w: p.width,       // footprint
                maxH: shelfHeight - itemH,     // 可用垂直空间
                baseH: itemH,                  // 支撑产品的顶面高度
            });
        }
    }

    if (airSpaces.length === 0) {
        return { stacks: [], remaining: stackableItems };
    }

    // 按空隙体积降序排列（大空隙优先）
    airSpaces.sort((a, b) => (b.l * b.w * b.maxH) - (a.l * a.w * a.maxH));

    const stacks = [];
    let remaining = [...stackableItems];

    for (const space of airSpaces) {
        if (remaining.length === 0) break;

        // 筛选能在空隙高度内放下的产品，预计算最佳朝向
        const candidates = [];
        for (const item of remaining) {
            const orient = pickBestOrientation(item, space.maxH);
            if (orient && orient.l <= space.l && orient.w <= space.w) {
                candidates.push({ item, l: orient.l, w: orient.w, h: orient.h });
            }
        }
        if (candidates.length === 0) continue;

        // 在这个空气隙内跑2D guillotine
        const result = pack2DGuillotine(candidates, space.l, space.w);
        if (!result || result.placements.length === 0) continue;

        // 记录堆叠位置（相对于层地板）
        for (const sp of result.placements) {
            stacks.push({
                skuId: sp.skuId,
                skuName: sp.skuName,
                x: space.x + sp.x,          // 全局x（层地板坐标系）
                z: space.z + sp.y,          // 全局z
                stackBase: space.baseH,     // 离层地板的偏移（支撑产品高度）
                length: sp.length,
                width: sp.width,
                height: sp.height,
                rotated: sp.rotated || false,
                originalDims: sp.originalDims,
                packagingType: sp.packagingType,
            });
        }

        // 从剩余池中移除已放置的
        const placedRefs = new Set(result.placements.map(sp => sp._itemRef));
        remaining = remaining.filter(item => !placedRefs.has(item));
    }

    return { stacks, remaining };
}

// ===== 2D Guillotine 矩形排布 =====

function pack2DGuillotine(items, binL, binW) {
    // 先按footprint面积降序排列
    const sorted = items.map((item, origIdx) => {
        // 支持两种输入：原始item（有dims）或预计算朝向（有l,w,h）
        if (item.l != null && item.w != null) {
            return { item: item.item || item, origIdx, l: item.l, w: item.w, h: item.h, isPlaced: false };
        }
        return { item, origIdx, l: item.dims.length, w: item.dims.width, h: item.dims.height, isPlaced: false };
    }).sort((a, b) => (b.l * b.w) - (a.l * a.w));

    // 自由矩形列表
    const freeRects = [{ x: 0, y: 0, l: binL, w: binW }];
    const placements = [];

    for (const elem of sorted) {
        const placed = placeBestFit(freeRects, elem.l, elem.w);
        if (!placed) {
            const placed2 = placeBestFit(freeRects, elem.w, elem.l);
            if (!placed2) continue; // 放不下这个，跳过（不整体失败）
            placed2.rotated = true;
            placed2.l = elem.w;
            placed2.w = elem.l;
            elem.isPlaced = true;
            placements.push({
                skuId: elem.item.skuId,
                skuName: elem.item.skuName,
                x: placed2.x,
                y: placed2.y,
                length: placed2.l,
                width: placed2.w,
                height: elem.h,
                rotated: true,
                originalDims: elem.item.originalDims,
                packagingType: elem.item.packagingType,
                _itemRef: elem.item,
            });
        } else {
            elem.isPlaced = true;
            placements.push({
                skuId: elem.item.skuId,
                skuName: elem.item.skuName,
                x: placed.x,
                y: placed.y,
                length: elem.l,
                width: elem.w,
                height: elem.h,
                rotated: false,
                originalDims: elem.item.originalDims,
                packagingType: elem.item.packagingType,
                _itemRef: elem.item,
            });
        }
    }

    const unplaced = sorted.filter(e => !e.isPlaced).map(e => e.item);
    return { placements, unplaced };
}

function placeBestFit(freeRects, itemL, itemW) {
    let bestIdx = -1;
    let bestShortSide = Infinity;
    let bestLongSide = Infinity;

    for (let i = 0; i < freeRects.length; i++) {
        const r = freeRects[i];
        if (r.l >= itemL && r.w >= itemW) {
            const shortSide = Math.min(r.l - itemL, r.w - itemW);
            const longSide = Math.max(r.l - itemL, r.w - itemW);
            if (shortSide < bestShortSide ||
                (shortSide === bestShortSide && longSide < bestLongSide)) {
                bestShortSide = shortSide;
                bestLongSide = longSide;
                bestIdx = i;
            }
        }
    }

    if (bestIdx === -1) return null;

    const rect = freeRects[bestIdx];
    const placed = { x: rect.x, y: rect.y, l: itemL, w: itemW };

    // Guillotine split: 水平分割
    const rightW = rect.l - itemL;
    const topH = rect.w - itemW;

    // 移除已用的矩形
    freeRects.splice(bestIdx, 1);

    // 添加新的自由矩形
    if (rightW > 0) {
        freeRects.push({ x: rect.x + itemL, y: rect.y, l: rightW, w: rect.w });
    }
    if (topH > 0) {
        freeRects.push({ x: rect.x, y: rect.y + itemW, l: itemL, w: topH });
    }

    return placed;
}

// ===== 多朝向工具 =====

/**
 * 生成3种朝向变体（每个维度分别当高度）
 * @param {Object} dims - {length, width, height}
 * @returns {Array} [{l, w, h}, ...]
 */
function generateItemOrientations(dims, packagingType) {
    const a = dims.length, b = dims.width, c = dims.height;
    if (packagingType !== 'soft') {
        return [
            { l: a, w: b, h: c },
            { l: b, w: a, h: c },
        ];
    }
    return [
        { l: a, w: b, h: c },  // 原始朝向（平躺）
        { l: a, w: c, h: b },  // 侧放
        { l: b, w: c, h: a },  // 竖放
    ];
}

/**
 * 在给定最大高度限制下，选出footprint面积最小的朝向
 * @param {Object} itemDims - {length, width, height}
 * @param {number} maxHeight
 * @returns {Object|null} {l, w, h} 或 null（都不满足）
 */
function pickBestOrientation(itemOrDims, maxHeight) {
    const itemDims = itemOrDims && itemOrDims.dims ? itemOrDims.dims : itemOrDims;
    const packagingType = itemOrDims && itemOrDims.dims ? itemOrDims.packagingType : null;
    const orients = generateItemOrientations(itemDims, packagingType);
    let best = null;
    let bestArea = Infinity;
    for (const o of orients) {
        if (o.h <= maxHeight) {
            const area = o.l * o.w;
            if (area < bestArea) {
                bestArea = area;
                best = o;
            }
        }
    }
    return best;
}

// ===== 辅助函数 =====

function classifyMixType(items) {
    let hasHard = false, hasSoft = false;
    for (const item of items) {
        if (item.packagingType === 'soft') hasSoft = true;
        else hasHard = true;
    }
    if (hasHard && hasSoft) return 'mixed_hard_soft';
    if (hasHard) return 'mixed_hard';
    return 'mixed_soft';
}

function makeResult(status, productVol, boxVol, utilization, message, layers) {
    return {
        status,
        productVolume: productVol,
        boxVolume: boxVol,
        volumeUtilization: utilization,
        message,
        layers: layers || [],
        verifiedFit: status === PACKING_STATUS.VERIFIED,
        estimatedFit: status === PACKING_STATUS.ESTIMATED,
        impossible: status === PACKING_STATUS.IMPOSSIBLE,
    };
}

// ===== 低位空腔吸附算法入口 =====
// 在 cavityBasedPacking 上层做与 generateMixedLayout 相同的接口封装

/**
 * 使用低位空腔吸附算法生成 3D 布局
 * 与 generateMixedLayout 接口完全一致，可无缝替换
 * @param {Object} group - MixedGroup
 * @param {Array} skus - 所有SKU数据
 * @param {Object} boxInternal - {length, width, height} 箱内径(cm)
 * @returns {Object} PackingResult（与 generateMixedLayout 格式一致）
 */
function generateMixedLayoutCavity(group, skus, boxInternal) {
    const skuMap = {};
    for (const s of skus) skuMap[s.id] = s;

    const items = [];
    for (const asgn of group.assignments) {
        const sku = skuMap[asgn.skuId];
        if (!sku) continue;
        const effDims = getEffectiveDimensions(sku);
        for (let i = 0; i < asgn.qtyPerBox; i++) {
            items.push({
                skuId: sku.id,
                skuName: sku.name,
                dims: effDims,
                originalDims: sku.dimensions,
                packagingType: sku.packagingType,
            });
        }
    }

    if (items.length === 0) {
        return makeResult(PACKING_STATUS.IMPOSSIBLE, 0, dimsVolume(boxInternal), 0, '没有产品可装', []);
    }

    const totalVol = items.reduce((sum, item) => sum + dimsVolume(item.dims), 0);
    const boxVol = dimsVolume(boxInternal);

    let cavityResult;
    if (totalVol > boxVol) {
        cavityResult = typeof cavityBasedPacking === 'function'
            ? cavityBasedPacking(items, boxInternal, true)
            : shelfLevelPacking(items, boxInternal, true);
        const base = makeResult(PACKING_STATUS.IMPOSSIBLE, totalVol, boxVol, 0,
            `产品总体积(${totalVol.toFixed(0)}cm³)超过箱内容积(${boxVol.toFixed(0)}cm³)`,
            cavityResult.layers);
        return Object.assign(base, {
            cavities: cavityResult.cavities || [],
            diagnostics: cavityResult.diagnostics || null,
            phase2Stats: cavityResult.phase2Stats || null,
            overflowItems: cavityResult.unplaced || (cavityResult.layers.length === 0 ? items : []),
        });
    }

    // 使用空腔吸附算法
    cavityResult = typeof cavityBasedPacking === 'function'
        ? cavityBasedPacking(items, boxInternal, false)
        : shelfLevelPacking(items, boxInternal, false);

    let base;
    if (cavityResult.success) {
        base = makeResult(PACKING_STATUS.VERIFIED, totalVol, boxVol, totalVol / boxVol,
            '空腔吸附算法验证通过', cavityResult.layers);
    } else {
        // 完整排列失败，降级
        const partial = typeof cavityBasedPacking === 'function'
            ? cavityBasedPacking(items, boxInternal, true)
            : shelfLevelPacking(items, boxInternal, true);
        const packingType = classifyMixType(items);
        const factor = PACKING_FACTORS[packingType] || 0.65;
        const usableVol = boxVol * factor;

        let status, msg;
        if (totalVol <= usableVol) {
            status = PACKING_STATUS.ESTIMATED;
            msg = `体积估算通过(填充系数${Math.round(factor * 100)}%) — 部分排列可视化`;
        } else {
            status = PACKING_STATUS.IMPOSSIBLE;
            msg = `超出估算容量 — 部分排列可视化`;
        }
        base = makeResult(status, totalVol, boxVol, totalVol / boxVol, msg, partial.layers);
        cavityResult = partial;
    }

    return Object.assign(base, {
        cavities: cavityResult.cavities || [],
        diagnostics: cavityResult.diagnostics || null,
        phase2Stats: cavityResult.phase2Stats || null,
        overflowItems: cavityResult.unplaced || (cavityResult.layers.length === 0 ? items : []),
    });
}

// ===== 判断当前是否可以使用空腔算法 =====

function isCavityAlgorithmAvailable() {
    return typeof cavityBasedPacking === 'function';
}

/**
 * 对混装组做自动均分
 * @param {Object} group
 * @param {Array} skus
 * @returns {Object} 更新后的assignments
 */
function autoBalanceGroup(group, skus) {
    const skuMap = {};
    for (const s of skus) skuMap[s.id] = s;

    const newAssignments = group.assignments.map(asgn => {
        const sku = skuMap[asgn.skuId];
        if (!sku) return asgn;
        const qtyPerBox = Math.ceil(sku.quantity / group.boxCount);
        return { ...asgn, qtyPerBox };
    });

    return newAssignments;
}

/**
 * 计算混装组的总剩余产品
 */
function calcGroupRemainder(group, skus) {
    const skuMap = {};
    for (const s of skus) skuMap[s.id] = s;

    let remainder = 0;
    for (const asgn of group.assignments) {
        const sku = skuMap[asgn.skuId];
        if (!sku) continue;
        const used = asgn.qtyPerBox * group.boxCount;
        remainder += Math.max(0, sku.quantity - used);
    }
    return remainder;
}
