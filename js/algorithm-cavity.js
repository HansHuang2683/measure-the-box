// ===== 低位空腔吸附算法 =====
// 两阶段装箱: Phase 1 硬包装主结构 → Phase 2 软包装低位空腔填充

// ===== 空腔数据结构 =====

/**
 * @typedef {Object} Cavity
 * @property {number} x - 左下前角 X 坐标 (沿长度方向)
 * @property {number} y - 左下前角 Y 坐标 (沿宽度方向)
 * @property {number} z - 左下前角 Z 坐标 (高度方向, 0=箱底)
 * @property {number} l - 长度
 * @property {number} w - 宽度
 * @property {number} h - 高度
 * @property {string} source - 空腔来源: 'initial' | 'after_item' | 'side' | 'top_platform'
 */

// ===== 空腔列表管理 =====

/**
 * 创建初始空腔（整个箱内空间）
 */
function createInitialCavities(boxL, boxW, boxH) {
    return [{ x: 0, y: 0, z: 0, l: boxL, w: boxW, h: boxH, source: 'initial' }];
}

/**
 * 判断两个 AABB 是否重叠
 */
function boxesOverlap(ax, ay, az, al, aw, ah, bx, by, bz, bl, bw, bh) {
    return ax < bx + bl && ax + al > bx &&
           ay < by + bw && ay + aw > by &&
           az < bz + bh && az + ah > bz;
}

/**
 * 从空腔列表中减去一个已放置的产品
 * 返回新的空腔列表（原列表不变）
 */
function subtractFromCavities(cavities, px, py, pz, pl, pw, ph, boxL, boxW, boxH) {
    const result = [];
    for (const cav of cavities) {
        // 不重叠 → 保留原空腔
        if (!boxesOverlap(cav.x, cav.y, cav.z, cav.l, cav.w, cav.h, px, py, pz, pl, pw, ph)) {
            result.push(cav);
            continue;
        }

        // 重叠 → 切割空腔（最多6个方向）
        // 先合并到完整空间再切，避免重复

        // 左边 (x 负方向)
        if (cav.x < px) {
            result.push({
                x: cav.x, y: cav.y, z: cav.z,
                l: px - cav.x, w: cav.w, h: cav.h,
                source: 'after_item',
            });
        }
        // 右边 (x 正方向)
        const itemRight = px + pl;
        const cavRight = cav.x + cav.l;
        if (itemRight < cavRight) {
            result.push({
                x: itemRight, y: cav.y, z: cav.z,
                l: cavRight - itemRight, w: cav.w, h: cav.h,
                source: 'after_item',
            });
        }
        // 前边 (y 负方向)
        if (cav.y < py) {
            result.push({
                x: Math.max(cav.x, px), y: cav.y, z: cav.z,
                l: Math.min(cavRight, itemRight) - Math.max(cav.x, px),
                w: py - cav.y,
                h: cav.h,
                source: 'after_item',
            });
        }
        // 后边 (y 正方向)
        const itemBack = py + pw;
        const cavBack = cav.y + cav.w;
        if (itemBack < cavBack) {
            result.push({
                x: Math.max(cav.x, px), y: itemBack, z: cav.z,
                l: Math.min(cavRight, itemRight) - Math.max(cav.x, px),
                w: cavBack - itemBack,
                h: cav.h,
                source: 'after_item',
            });
        }
        // 上边 (z 正方向)
        const itemTop = pz + ph;
        const cavTop = cav.z + cav.h;
        if (itemTop < cavTop) {
            result.push({
                x: Math.max(cav.x, px), y: Math.max(cav.y, py),
                z: itemTop,
                l: Math.min(cavRight, itemRight) - Math.max(cav.x, px),
                w: Math.min(cavBack, itemBack) - Math.max(cav.y, py),
                h: cavTop - itemTop,
                source: 'after_item',
            });
        }
        // 下边 (z 负方向) — 通常不会发生，因为产品从底向上放
        if (cav.z < pz) {
            result.push({
                x: Math.max(cav.x, px), y: Math.max(cav.y, py),
                z: cav.z,
                l: Math.min(cavRight, itemRight) - Math.max(cav.x, px),
                w: Math.min(cavBack, itemBack) - Math.max(cav.y, py),
                h: pz - cav.z,
                source: 'after_item',
            });
        }
    }
    return result;
}

/**
 * 从已放置的产品列表构建空腔列表
 */
function buildCavitiesFromPlaced(placedItems, boxL, boxW, boxH) {
    let cavities = createInitialCavities(boxL, boxW, boxH);
    for (const item of placedItems) {
        cavities = subtractFromCavities(cavities,
            item.x, item.y, item.z, item.l, item.w, item.h,
            boxL, boxW, boxH);
    }
    // 过滤掉体积过小的空腔（< 1cm³）
    cavities = cavities.filter(c => c.l >= 0.5 && c.w >= 0.5 && c.h >= 0.5 && c.l * c.w * c.h >= 1);
    return cavities;
}

// ===== 候选位置评分函数 =====

function scoreCavityPlacement(cavity, itemOrient, placedItems, boxL, boxW, boxH) {
    const itemVol = itemOrient.l * itemOrient.w * itemOrient.h;
    const cavVol = cavity.l * cavity.w * cavity.h;
    let score = 0;

    // 1. 低 Z 得分（最重要）
    const heightRatio = cavity.z / boxH;
    score += (1 - heightRatio) * 500;

    // 2. 体积利用率（匹配度）
    const volRatio = Math.min(itemVol / cavVol, 1);
    score += volRatio * 100;

    // 3. 新增整体高度惩罚（放得越低越好）
    const newTop = cavity.z + itemOrient.h;
    const heightIncrease = newTop / boxH;
    score -= heightIncrease * 200;

    // 4. 底部支撑检查（90% 以上支撑加分，否则减分）
    const support = calcSupportRatio(cavity.x, cavity.y, itemOrient.l, itemOrient.w, placedItems, boxL, boxW);
    if (support >= 0.9) {
        score += 100;
    } else if (support >= 0.7) {
        score += 50;
    } else if (support >= 0.5) {
        score += 10;
    } else {
        score -= 200; // 支撑严重不足
    }

    // 5. 侧边贴合度（与已有产品的接触面积）
    const contact = calcContactArea(cavity.x, cavity.y, cavity.z, itemOrient.l, itemOrient.w, itemOrient.h, placedItems);
    score += Math.min(contact / (itemOrient.l * itemOrient.h + itemOrient.w * itemOrient.h), 1) * 80;

    // 6. 剩余空间规整度：尽量不产生碎片化
    // 通过衡量放置后空间的长宽比来判断
    const remainingL = boxL - (cavity.x + itemOrient.l);
    const remainingW = boxW - (cavity.y + itemOrient.w);
    const remainingH = boxH - (cavity.z + itemOrient.h);
    if (remainingL > 0 && remainingW > 0 && remainingH > 0) {
        const ratio = Math.max(remainingL, remainingW) / (Math.min(remainingL, remainingW) + 0.1);
        score -= Math.min(ratio, 5) * 10;
    }

    return score;
}

/**
 * 计算底部支撑比例
 */
function calcSupportRatio(x, y, l, w, placedItems, boxL, boxW) {
    // 如果在箱底 (z=0)，完全支撑
    // 注意：这里调用时 z 参数已经在筛选阶段确定，此函数只检查已有产品支撑
    // 如果产品直接放在箱底，视为完全支撑
    // 但如果放在已有产品上方，需要检查支撑

    // 通过检查调用栈的 itemZ 来确定，但我们在这里不知道 z
    // 所以约定：cavity.z === 0 意味着箱底支撑
    // 对于 cavity.z > 0 的空腔，需要检查下方是否有足够支撑
    // 但这需要 context，所以简化为：只要空腔位于箱底就有 100% 支撑
    // 否则由调用方决定

    // 简化版：箱底支撑 100%，非箱底需要检查
    return 1.0; // 由调用方根据 cavity.z 判断
}

/**
 * 计算侧边贴合面积
 */
function calcContactArea(x, y, z, l, w, h, placedItems) {
    let contact = 0;
    for (const item of placedItems) {
        // 检查是否在 Z 方向有重叠（产品侧面接触需要同一高度范围）
        const zOverlap = Math.max(0, Math.min(z + h, item.z + item.h) - Math.max(z, item.z));
        if (zOverlap <= 0) continue;

        // X 方向相邻（Y 方向重叠）
        const yOverlap = Math.max(0, Math.min(y + w, item.y + item.w) - Math.max(y, item.y));
        if (yOverlap > 0) {
            if (Math.abs(x - (item.x + item.l)) < 0.01 || Math.abs(x + l - item.x) < 0.01) {
                contact += yOverlap * zOverlap;
            }
        }

        // Y 方向相邻（X 方向重叠）
        const xOverlap = Math.max(0, Math.min(x + l, item.x + item.l) - Math.max(x, item.x));
        if (xOverlap > 0) {
            if (Math.abs(y - (item.y + item.w)) < 0.01 || Math.abs(y + w - item.y) < 0.01) {
                contact += xOverlap * zOverlap;
            }
        }
    }
    return contact;
}

// ===== 产品朝向枚举 =====

/**
 * 枚举产品在空腔内的所有允许朝向
 * @param {Object} dims - {length, width, height} 产品原始尺寸
 * @param {number} maxL - 空腔长度
 * @param {number} maxW - 空腔宽度
 * @param {number} maxH - 空腔高度
 * @returns {Array} [{l, w, h}] 所有可放入的朝向
 */
function enumerateFitOrientations(dims, maxL, maxW, maxH) {
    const a = dims.length, b = dims.width, c = dims.height;
    const allOrientations = [
        { l: a, w: b, h: c },
        { l: a, w: c, h: b },
        { l: b, w: a, h: c },
        { l: b, w: c, h: a },
        { l: c, w: a, h: b },
        { l: c, w: b, h: a },
    ];
    return allOrientations.filter(o => o.l <= maxL && o.w <= maxW && o.h <= maxH);
}

// ===== Phase 2: 空腔填充 =====

/**
 * 将软包装/小件填充到空腔中
 * @param {Array} items - 待填充的产品 [{skuId, skuName, dims, originalDims, packagingType}]
 * @param {Array} cavities - 当前可用空腔列表
 * @param {Array} placedItems - 已放置的产品（Phase 1）
 * @param {Object} boxInternal - {length, width, height}
 * @returns {Object} {placements, unplaced, diagnostics}
 */
function fillCavities(items, cavities, placedItems, boxInternal) {
    const placements = [];
    const unplaced = [];
    const cavityDiag = {
        initialCavityCount: cavities.length,
        attemptedItems: 0,
        placedItems: 0,
        failedItems: [],
    };

    // 按体积从小到大排序（小件优先填充）
    const sorted = [...items].sort((a, b) => dimsVolume(a.dims) - dimsVolume(b.dims));

    let currentCavities = [...cavities];
    // 按 z 坐标升序排列（低位优先）
    currentCavities.sort((a, b) => a.z - b.z || b.l * b.w * b.h - a.l * a.w * a.h);

    for (const item of sorted) {
        cavityDiag.attemptedItems++;
        let bestScore = -Infinity;
        let bestCavity = null;
        let bestOrient = null;
        let bestIdx = -1;

        for (let ci = 0; ci < currentCavities.length; ci++) {
            const cav = currentCavities[ci];

            // 空腔太小直接跳过
            if (cav.l < 0.5 || cav.w < 0.5 || cav.h < 0.5) continue;

            // 尝试所有朝向
            const fitOrients = enumerateFitOrientations(item.dims, cav.l, cav.w, cav.h);
            if (fitOrients.length === 0) continue;

            // 检查底部支撑
            const hasFloorSupport = cav.z < 0.01; // 在箱底
            let supportOk = false;
            if (hasFloorSupport) {
                supportOk = true;
            } else {
                // 需要检查是否有足够支撑
                // 先尝试最好的朝向
                supportOk = checkCavitySupport(cav, placedItems, boxInternal);
            }
            if (!supportOk) continue;

            for (const orient of fitOrients) {
                const score = scoreCavityPlacement(cav, orient, placedItems, boxInternal.length, boxInternal.width, boxInternal.height);
                // 额外惩罚：超过箱子高度的放置
                if (cav.z + orient.h > boxInternal.height) continue;

                if (score > bestScore) {
                    bestScore = score;
                    bestCavity = cav;
                    bestOrient = orient;
                    bestIdx = ci;
                }
            }
        }

        if (bestCavity && bestOrient) {
            const placement = {
                skuId: item.skuId,
                skuName: item.skuName,
                x: bestCavity.x,
                y: bestCavity.y,
                z: bestCavity.z,
                length: bestOrient.l,
                width: bestOrient.w,
                height: bestOrient.h,
                rotated: bestOrient.l !== item.dims.length || bestOrient.w !== item.dims.width,
                originalDims: item.originalDims,
                packagingType: item.packagingType,
                cavityScore: bestScore,
            };
            placements.push(placement);

            // 更新已放置列表和空腔列表
            placedItems.push({
                x: bestCavity.x, y: bestCavity.y, z: bestCavity.z,
                l: bestOrient.l, w: bestOrient.w, h: bestOrient.h,
            });
            currentCavities = subtractFromCavities(currentCavities,
                bestCavity.x, bestCavity.y, bestCavity.z,
                bestOrient.l, bestOrient.w, bestOrient.h,
                boxInternal.length, boxInternal.width, boxInternal.height);
            // 重新按 z 排序
            currentCavities.sort((a, b) => a.z - b.z || b.l * b.w * b.h - a.l * a.w * a.h);

            cavityDiag.placedItems++;
        } else {
            // 诊断：为什么放不下
            const reasons = diagnoseUnplaced(item, currentCavities, boxInternal);
            unplaced.push({ ...item, reason: reasons });
            cavityDiag.failedItems.push({
                skuName: item.skuName,
                dims: item.dims,
                reason: reasons,
            });
        }
    }

    return { placements, unplaced, diagnostics: cavityDiag };
}

/**
 * 检查空腔底部是否有足够支撑
 */
function checkCavitySupport(cavity, placedItems, boxInternal) {
    // 在箱底 (z=0) → 完全支撑
    if (cavity.z < 0.01) return true;

    // 在已有产品上方，检查下方是否有足够支撑面积
    const cavFootprint = cavity.l * cavity.w;
    let supportArea = 0;

    // 空腔底面积
    for (const item of placedItems) {
        // 只检查正好在空腔正下方的产品（item.z + item.h === cavity.z）
        if (Math.abs(item.z + item.h - cavity.z) > 0.1) continue;

        // 计算重叠面积
        const ox = Math.max(0, Math.min(item.x + item.l, cavity.x + cavity.l) - Math.max(item.x, cavity.x));
        const oy = Math.max(0, Math.min(item.y + item.w, cavity.y + cavity.w) - Math.max(item.y, cavity.y));
        supportArea += ox * oy;
    }

    const ratio = supportArea / cavFootprint;
    // 软包装至少 50% 支撑
    return ratio >= 0.5;
}

/**
 * 诊断产品为何无法放入任何空腔
 */
function diagnoseUnplaced(item, cavities, boxInternal) {
    const reasons = [];
    const d = item.dims;
    const boxH = boxInternal.height;

    // 尝试所有朝向和空腔，看哪个维度不足
    let maxFitL = 0, maxFitW = 0, maxFitH = 0;
    for (const cav of cavities) {
        const orients = enumerateFitOrientations(d, cav.l, cav.w, cav.h);
        for (const o of orients) {
            if (o.l > maxFitL) maxFitL = o.l;
            if (o.w > maxFitW) maxFitW = o.w;
            if (o.h > maxFitH) maxFitH = o.h;
        }
    }

    // 逐一检查6种朝向
    let anyFitLength = false, anyFitWidth = false, anyFitHeight = false;
    for (const cav of cavities) {
        const orients = enumerateFitOrientations(d, cav.l, cav.w, cav.h);
        if (orients.length > 0) {
            // 至少有一个朝向可以放入某个空腔
            // 检查底部支撑
            const supportOk = checkCavitySupport(cav, [], boxInternal);
            if (!supportOk && cav.z > 0.01) {
                reasons.push('底部支撑不足（需≥50%面积支撑）');
            }
            if (orients.length > 0) {
                // 存在理论上可用的空腔，但评分排序或其他原因导致未选中
                reasons.push('所有候选位置评分不足（低位空腔已被优先占用）');
            }
            break;
        }
    }

    if (reasons.length === 0) {
        // 检查具体哪个维度受限
        const a = d.length, b = d.width, c = d.height;
        const all6 = [
            [a, b, c], [a, c, b], [b, a, c],
            [b, c, a], [c, a, b], [c, b, a],
        ];

        let canFitL = false, canFitW = false, canFitH = false;
        for (const cav of cavities) {
            for (const o of all6) {
                if (o[0] <= cav.l) canFitL = true;
                if (o[1] <= cav.w) canFitW = true;
                if (o[2] <= cav.h) canFitH = true;
            }
        }

        if (!canFitL) reasons.push('所有空腔长度不足（产品最长边' + d.length + 'cm，' +
            '最大可用长度' + cavities.reduce((m, c) => Math.max(m, c.l), 0).toFixed(1) + 'cm）');
        if (!canFitW) reasons.push('所有空腔宽度不足（产品宽度' + d.width + 'cm）');
        if (!canFitH) reasons.push('所有空腔高度不足（产品高度' + d.height + 'cm）');
        if (reasons.length === 0) {
            reasons.push('无可用空腔（所有空腔已被填充或空间碎片化）');
        }
    }

    return reasons.join('；');
}

// ===== 从 Phase 1 层架数据提取已放置产品 =====

function extractPlacedItemsFromLayers(layers) {
    const items = [];
    for (const layer of layers) {
        const yOff = layer.yOffset || 0;
        for (const p of layer.placements || []) {
            items.push({
                x: p.x, y: p.y, z: yOff,
                l: p.length, w: p.width, h: p.height || layer.height,
                skuId: p.skuId, skuName: p.skuName,
                packagingType: p.packagingType,
            });
        }
        for (const s of layer.stacks || []) {
            items.push({
                x: s.x, y: s.z, z: yOff + (s.stackBase || 0),
                l: s.length, w: s.width, h: s.height,
                skuId: s.skuId, skuName: s.skuName,
                packagingType: s.packagingType,
            });
        }
    }
    return items;
}

// ===== 将 Phase 2 放置合并到现有层架中 =====

function mergePhase2Into(phase2Placements, layers) {
    // 如果 Phase 1 没有产生任何层（全软包装场景），创建一个默认层
    if (layers.length === 0 && phase2Placements.length > 0) {
        // 计算最大高度
        let maxH = 0;
        for (const p of phase2Placements) {
            maxH = Math.max(maxH, p.z + p.height);
        }
        layers.push({
            height: maxH || 1,
            yOffset: 0,
            placements: [],
            stacks: [],
            itemCount: 0,
            boxOrientation: null,
        });
    }

    // 将 cavities 内的放置按 z 坐标分配到底部最近的层
    for (const p of phase2Placements) {
        const pz = p.z;
        // 找到最近的层（z 位置不超过 pz）
        let targetLayer = null;
        for (const layer of layers) {
            const layerBottom = layer.yOffset || 0;
            if (pz >= layerBottom - 0.01) {
                targetLayer = layer;
            }
        }

        if (targetLayer) {
            // 作为 stacks 加入目标层
            if (!targetLayer.stacks) targetLayer.stacks = [];
            const layerBottom = targetLayer.yOffset || 0;
            targetLayer.stacks.push({
                skuId: p.skuId,
                skuName: p.skuName,
                x: p.x,
                z: p.y, // 注意：stacks 中 z 是宽度方向（与 placements.y 对应）
                stackBase: p.z - layerBottom,
                length: p.length,
                width: p.width,
                height: p.height,
                rotated: p.rotated || false,
                originalDims: p.originalDims,
                packagingType: p.packagingType,
                _cavityPlaced: true,
            });
            targetLayer.itemCount = (targetLayer.itemCount || 0) + 1;
        }
    }
}

// ===== 空间诊断 =====

function generateSpaceDiagnostics(layers, cavities, boxInternal, unplaced) {
    const allPlaced = extractPlacedItemsFromLayers(layers);
    const maxHeight = allPlaced.reduce((m, p) => Math.max(m, p.z + p.h), 0);

    const lowCavities = cavities.filter(c => c.z < boxInternal.height * 0.5);
    const sideCavities = cavities.filter(c => c.source === 'side' || c.z < maxHeight * 0.5);

    return {
        maxHeight: maxHeight,
        lowCavityCount: lowCavities.length,
        sideCavityCount: sideCavities.length,
        topPlatformCount: cavities.filter(c => c.z > 0 && c.z < maxHeight).length,
        gapCount: cavities.filter(c => c.source === 'after_item').length,
        smallItemsLow: unplaced.length === 0 || unplaced.every(u => u.reason),
        unplacedDiagnostics: unplaced,
    };
}

// ===== 主入口：低位空腔吸附装箱 =====

/**
 * 两阶段装箱：先放硬包装主结构，再将软包装填充到低位空腔
 * @param {Array} items - 所有产品 [{skuId, skuName, dims, originalDims, packagingType}]
 * @param {Object} boxInternal - {length, width, height}
 * @param {boolean} allowPartial - 是否允许部分排列
 * @returns {Object} {success, layers, unplaced, diagnostics, cavities}
 */
function cavityBasedPacking(items, boxInternal, allowPartial) {
    // 分类：硬包装 → Phase 1，软包装 → Phase 2
    const hardItems = items.filter(i => i.packagingType !== 'soft');
    const softItems = items.filter(i => i.packagingType === 'soft');

    let allHardFailed = false;

    // Phase 1: 硬包装/大件主结构
    let phase1Result;
    if (hardItems.length > 0) {
        phase1Result = shelfLevelPacking(hardItems, boxInternal, allowPartial);
        // 如果硬包装都放不下且允许部分排列，后面会处理
        if (!phase1Result.success && !allowPartial) {
            // 硬包装都装不下，尝试把所有东西放一起
            allHardFailed = true;
        }
    } else {
        // 没有硬包装，跳过 Phase 1
        phase1Result = { success: true, layers: [], unplaced: [] };
    }

    // 使用 Phase 1 选定的箱子朝向（关键！Phase 2 的空腔必须与 Phase 1 同坐标系）
    const boxOrient = (phase1Result.layers && phase1Result.layers[0] && phase1Result.layers[0].boxOrientation)
        || boxInternal;

    // 从 Phase 1 提取已放置产品位置
    const placedItems = extractPlacedItemsFromLayers(phase1Result.layers);

    // 检测空腔（使用 boxOrient 而非 boxInternal，坐标系统一）
    const cavities = buildCavitiesFromPlaced(placedItems,
        boxOrient.length, boxOrient.width, boxOrient.height);

    // Phase 2: 软包装空腔填充
    const phase2Result = fillCavities(softItems, cavities, placedItems, boxOrient);

    // 合并 Phase 2 放置到层数据
    mergePhase2Into(phase2Result.placements, phase1Result.layers);

    // 生成空间诊断
    const finalCavities = buildCavitiesFromPlaced(extractPlacedItemsFromLayers(phase1Result.layers),
        boxOrient.length, boxOrient.width, boxOrient.height);
    const diagnostics = generateSpaceDiagnostics(phase1Result.layers, finalCavities, boxInternal, phase2Result.unplaced);

    const allUnplaced = [...(phase1Result.unplaced || []), ...phase2Result.unplaced];
    const allSuccess = phase1Result.success && phase2Result.unplaced.length === 0;

    return {
        success: allSuccess || allowPartial,
        layers: phase1Result.layers,
        unplaced: allUnplaced,
        cavities: finalCavities,
        diagnostics,
        phase1Success: phase1Result.success,
        phase2Stats: {
            placed: phase2Result.placements.length,
            unplaced: phase2Result.unplaced.length,
            total: softItems.length,
        },
    };
}

// ===== 用于 3D 可视化的空腔数据 =====

function getCavitiesForVisualization(cavities, boxScale) {
    return cavities.map(c => ({
        x: c.x, y: c.y, z: c.z,
        l: c.l, w: c.w, h: c.h,
        source: c.source,
    }));
}
