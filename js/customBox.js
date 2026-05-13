// ===== 定制箱子建议（增强版）=====

/**
 * 主入口：为剩余产品推荐装箱方案
 * 区分硬包装/软包装，自动计算装箱方案、混装可行性
 * @param {Array} remainingItems - [{ skuName, dims:{length,width,height}, qty, packagingType, softTolerance }]
 * @param {number} gap - 间隙(cm)
 * @param {number} maxSide - 最大边长(cm)
 * @param {number} wallThickness - 壁厚(cm)
 * @returns {Array} 方案列表 (SkuPlan | FillerPlan | SoftMixedPlan)
 */
function suggestCustomBoxes(remainingItems, gap, maxSide, wallThickness) {
    gap = gap || CONFIG.defaultGap;
    maxSide = maxSide || CONFIG.maxSide;
    wallThickness = wallThickness || CONFIG.defaultWallThickness;
    const suggestions = [];

    // Step 1: 分类
    const { hardItems, softItems } = _classifyItems(remainingItems);

    // Step 2: 处理每个硬包装SKU
    const hardPlans = [];
    for (const item of hardItems) {
        const plan = _analyzeHardSku(item, gap, maxSide, wallThickness);
        if (plan) hardPlans.push(plan);
    }

    // Step 3: 尝试将软包装塞进硬包装箱剩余空间
    const allocatedSoft = new Set();
    for (const hardPlan of hardPlans) {
        const remainingSoft = softItems.filter(s => !allocatedSoft.has(s.skuName));
        for (const soft of remainingSoft) {
            const filler = _trySoftFiller(soft, hardPlan, maxSide);
            if (filler) {
                hardPlan.fillableSkus.push(filler);
                hardPlan.canMix = true;
                allocatedSoft.add(soft.skuName);
                break;
            }
        }
    }

    suggestions.push(...hardPlans);

    // Step 4: 剩余软包装合箱
    const unallocatedSoft = softItems.filter(s => !allocatedSoft.has(s.skuName));
    if (unallocatedSoft.length > 0) {
        const mixed = _suggestSoftMixedBox(unallocatedSoft, gap, maxSide, wallThickness);
        if (mixed) suggestions.push(mixed);
    }

    return suggestions;
}

// 调整常量（产品尺寸→外箱尺寸的总调整量，含安全余量和壁厚）
const ADJUST_HARD = CONFIG.adjustHard;    // 硬包装：各方向 +1.0cm
const ADJUST_SOFT = CONFIG.adjustSoft;    // 软包装：各方向 0cm（可压缩）
const SOFT_COMPRESS = CONFIG.softCompress; // 软包装可压缩量，用于填充判断

/**
 * 将剩余产品分为硬包装和软包装
 */
function _classifyItems(items) {
    const hard = [];
    const soft = [];
    for (const item of items) {
        const type = item.packagingType || 'hard';
        if (type === 'hard') {
            hard.push(item);
        } else {
            soft.push(item);
        }
    }
    // 硬包装按体积降序（大件优先处理）
    hard.sort((a, b) => dimsVolume(b.dims) - dimsVolume(a.dims));
    return { hardItems: hard, softItems: soft };
}

/**
 * 分析硬包装SKU，找到最优装箱方案
 * 枚举6种摆放朝向，计算单箱最优数量
 */
function _analyzeHardSku(item, gap, maxSide, wallThickness) {
    const d = item.dims;
    const targetQty = item.qty;
    const orientations = generateOrientations(d);
    let bestPlan = null;

    for (const orient of orientations) {
        // orient = {length, width, height}
        // 判断底面是否能放入maxSide限制
        const footprintL = orient.length + ADJUST_HARD;
        const footprintW = orient.width + ADJUST_HARD;
        if (footprintL > maxSide || footprintW > maxSide) continue;

        // 在高度方向能叠放几个
        const maxStack = Math.floor((maxSide - ADJUST_HARD) / orient.height);
        if (maxStack <= 0) continue;

        // 寻找最优单箱数量
        let bestN = 0;
        let bestScore = -Infinity;

        for (let n = 1; n <= maxStack; n++) {
            const extH = n * orient.height + ADJUST_HARD;
            if (extH > maxSide) continue;

            const boxesNeeded = Math.ceil(targetQty / n);
            const remainder = targetQty % n;
            const isExact = remainder === 0;
            const emptySpace = boxesNeeded * n - targetQty;

            // 评分：刚好装完 > 整数箱 > 箱数少 > 空箱率低 > 利用率高
            let score = 0;
            if (isExact) score += 10000;
            else if (targetQty % n === 0 || n === targetQty) score += 5000;
            score += Math.max(0, 100 - boxesNeeded) * 100;
            score -= emptySpace * 10;

            if (score > bestScore) {
                bestScore = score;
                bestN = n;
            }
        }

        if (bestN <= 0) continue;

        // 生成方案
        const perBox = bestN;
        const boxes = Math.ceil(targetQty / perBox);
        const extL = +(orient.length + ADJUST_HARD).toFixed(1);
        const extW = +(orient.width + ADJUST_HARD).toFixed(1);
        const extH = +(perBox * orient.height + ADJUST_HARD).toFixed(1);
        const internalH = +(perBox * orient.height).toFixed(1);
        const maxSideVal = Math.max(extL, extW, extH);

        // 判断摆放方式
        let orientationLabel = '旋转摆放';
        if (Math.abs(orient.length - d.length) < 0.01 && Math.abs(orient.width - d.width) < 0.01) {
            orientationLabel = '平放叠加';
        } else if (Math.abs(orient.length - d.width) < 0.01 && Math.abs(orient.width - d.height) < 0.01) {
            orientationLabel = '立放叠加';
        } else if (Math.abs(orient.length - d.length) < 0.01 && Math.abs(orient.width - d.height) < 0.01) {
            orientationLabel = '侧放叠加';
        }

        const isExactFit = targetQty % perBox === 0;

        const plan = {
            type: 'hard',
            skuName: item.skuName,
            packagingType: '硬包装',
            remainingQty: targetQty,
            productDims: dimsClone(d),
            orientation: dimsClone(orient),
            orientationLabel: orientationLabel,
            perBoxCount: perBox,
            boxCount: boxes,
            internalNeeds: dims(orient.length, orient.width, internalH),
            externalDims: dims(extL, extW, extH),
            maxSideOk: maxSideVal <= maxSide,
            maxSideValue: maxSideVal,
            singleSkuBox: true,
            canMix: false,
            fillableSkus: [],
            calcBasis: _generateCalcBasisHard(item, orient, perBox, boxes, internalH, extL, extW, extH, isExactFit),
            riskTips: _generateRiskTipsHard(item, orient, perBox, maxSideVal),
        };

        // 择优
        if (!bestPlan ||
            (perBox > bestPlan.perBoxCount) ||
            (perBox === bestPlan.perBoxCount && boxes < bestPlan.boxCount) ||
            (perBox === bestPlan.perBoxCount && boxes === bestPlan.boxCount && maxSideVal < bestPlan.maxSideValue)) {
            bestPlan = plan;
        }
    }

    return bestPlan || null;
}

/**
 * 生成计算依据
 */
function _generateCalcBasisHard(item, orient, perBox, boxes, internalH, extL, extW, extH, isExact) {
    const d = item.dims;
    const basis = [];
    basis.push(`产品尺寸 ${d.length}×${d.width}×${d.height}cm`);
    basis.push(`采用「${_getOrientationDesc(orient, d)}」摆放，底面 ${orient.length}×${orient.width}cm，叠加方向 ${orient.height}cm`);
    basis.push(`${perBox}个叠放高度 ${orient.height}×${perBox} = ${internalH}cm`);
    basis.push(`考虑装箱余量和纸箱厚度，推荐外箱约 ${extL.toFixed(1)}×${extW.toFixed(1)}×${extH.toFixed(1)}cm`);
    const maxSide = Math.max(extL, extW, extH);
    basis.push(`最长边 ${maxSide}cm，${maxSide <= 60 ? '未超过 60cm 限制' : '超过 60cm 限制，建议减少单箱数量'}`);
    if (isExact) {
        basis.push(`共 ${boxes} 箱可恰好装完剩余 ${item.qty} 个`);
    } else {
        const lastBox = item.qty - (boxes - 1) * perBox;
        basis.push(`共 ${boxes} 箱，前 ${boxes - 1} 箱每箱 ${perBox} 个，最后一箱 ${lastBox} 个`);
    }
    return basis;
}

function _getOrientationDesc(orient, orig) {
    if (Math.abs(orient.length - orig.length) < 0.01 && Math.abs(orient.width - orig.width) < 0.01) return '平放叠加';
    if (Math.abs(orient.length - orig.width) < 0.01 && Math.abs(orient.width - orig.height) < 0.01) return '立放叠加';
    if (Math.abs(orient.length - orig.length) < 0.01 && Math.abs(orient.width - orig.height) < 0.01) return '侧放叠加';
    return '旋转摆放';
}

/**
 * 生成风险提示
 */
function _generateRiskTipsHard(item, orient, perBox, maxSideVal) {
    const tips = [];
    tips.push('采购纸箱前需确认供应商标注的是内径还是外径');
    if (maxSideVal > 58) {
        tips.push(`最长边 ${maxSideVal}cm 接近 60cm 限制，实际装箱时需严格控制尺寸`);
    }
    // 硬包装默认需要缓冲提示
    tips.push('如果产品硬包装不能受压，需要预留更多缓冲空间');
    tips.push('建议先打样测试，确认产品能顺利装入');
    return tips;
}

/**
 * 尝试将软包装SKU塞进硬包装箱剩余空间
 */
function _trySoftFiller(softItem, hardPlan, maxSide) {
    const sd = softItem.dims;
    // 软包装可压缩尺寸
    const compLen = Math.max(0.1, sd.length - SOFT_COMPRESS);
    const compWid = Math.max(0.1, sd.width - SOFT_COMPRESS);
    const compHgt = Math.max(0.1, sd.height - SOFT_COMPRESS);

    // 硬包装箱内剩余空间估算（外箱尺寸 - 调整量 = 近似可用内空）
    const ext = hardPlan.externalDims;
    // 理论上 internal ≈ external（因为 ADJUST_HARD 已是总调整量）
    // 剩余空间 ≈ 外箱 - 产品占用
    const productVol = hardPlan.perBoxCount * dimsVolume(hardPlan.productDims);
    const boxVol = dimsVolume(ext);
    const remainingVol = boxVol - productVol;

    // 顶部剩余高度
    const topRemainH = ext.height - hardPlan.perBoxCount * hardPlan.orientation.height;

    // 判断软包装能否塞入顶部空间
    if (topRemainH >= compHgt || topRemainH >= compLen || topRemainH >= compWid) {
        // 尝试每种朝向
        const softOrient = generateOrientations(dims(compLen, compWid, compHgt));
        for (const so of softOrient) {
            if (so.height <= topRemainH &&
                so.length <= ext.length &&
                so.width <= ext.width) {
                const maxFit = Math.floor(topRemainH / so.height);
                return {
                    type: 'filler',
                    skuName: softItem.skuName,
                    remainingQty: softItem.qty,
                    productDims: dimsClone(softItem.dims),
                    packagingType: '软包装',
                    hostSkuName: hardPlan.skuName,
                    fillQty: Math.min(maxFit, softItem.qty),
                    method: '顶部空间',
                    note: `可利用「${hardPlan.skuName}」箱内顶部约 ${topRemainH.toFixed(1)}cm 空间混装`
                };
            }
        }
    }

    // 侧边剩余空间
    const sideRemainL = ext.length - hardPlan.orientation.length;
    const sideRemainW = ext.width - hardPlan.orientation.width;

    if (sideRemainL >= compLen || sideRemainW >= compWid) {
        return {
            type: 'filler',
            skuName: softItem.skuName,
            remainingQty: softItem.qty,
            productDims: dimsClone(softItem.dims),
            packagingType: '软包装',
            hostSkuName: hardPlan.skuName,
            fillQty: 1,
            method: '侧边空间',
            note: `可利用「${hardPlan.skuName}」箱内侧面剩余空间混装少量软包装`
        };
    }

    return null;
}

/**
 * 软包装合箱方案
 */
function _suggestSoftMixedBox(softItems, gap, maxSide, wallThickness) {
    if (softItems.length === 0) return null;

    // 取最大的软包装尺寸做基准（压缩后尺寸）
    const maxDims = softItems.reduce((acc, item) => ({
        length: Math.max(acc.length, Math.max(0.1, item.dims.length - SOFT_COMPRESS)),
        width: Math.max(acc.width, Math.max(0.1, item.dims.width - SOFT_COMPRESS)),
        height: Math.max(acc.height, Math.max(0.1, item.dims.height - SOFT_COMPRESS)),
    }), { length: 0, width: 0, height: 0 });

    const totalQty = softItems.reduce((s, item) => s + item.qty, 0);

    // 简单方案：按最大尺寸的朝向枚举
    const orientations = generateOrientations(maxDims);
    let bestPlan = null;

    for (const orient of orientations) {
        const maxStack = Math.floor((maxSide - ADJUST_SOFT) / orient.height);
        if (maxStack <= 0) continue;

        for (let n = Math.min(maxStack, totalQty); n >= 1; n--) {
            const extH = n * orient.height + ADJUST_SOFT;
            const extL = orient.length + ADJUST_SOFT;
            const extW = orient.width + ADJUST_SOFT;
            if (extL > maxSide || extW > maxSide || extH > maxSide) continue;

            const boxes = Math.ceil(totalQty / n);
            const maxSideVal = Math.max(extL, extW, extH);

            const plan = {
                type: 'soft_mixed',
                skus: softItems.map(s => ({ skuName: s.skuName, qty: s.qty })),
                totalQty: totalQty,
                externalDims: dims(
                    +(extL).toFixed(1),
                    +(extW).toFixed(1),
                    +(extH).toFixed(1)
                ),
                perBoxCount: n,
                boxCount: boxes,
                maxSideOk: maxSideVal <= maxSide,
                maxSideValue: maxSideVal,
                calcBasis: [
                    `软包装 SKU 共 ${softItems.length} 款，合计 ${totalQty} 个`,
                    `按最大尺寸 ${maxDims.length}×${maxDims.width}×${maxDims.height}cm 估算`,
                    `每箱装 ${n} 个，共 ${boxes} 箱`,
                ],
                riskTips: [
                    '软包装可轻微压缩，装箱时注意不要过度挤压',
                    '混装时注意避免外箱鼓包',
                    '如果实际产品尺寸差异较大，建议分箱装运',
                ],
            };

            if (!bestPlan || (boxes < bestPlan.boxCount && maxSideVal <= bestPlan.maxSideValue)) {
                bestPlan = plan;
            }
            break;
        }
    }

    return bestPlan;
}

/**
 * 判断是否需要触发定制箱建议
 * @param {number} remainderQty - 剩余数量
 * @param {number} totalQty - 总数量
 * @param {number} perBoxCap - 单箱容量
 * @returns {boolean}
 */
function shouldSuggestCustom(remainderQty, totalQty, perBoxCap) {
    if (remainderQty <= 0) return false;
    const ratio = remainderQty / totalQty;
    return ratio >= CONFIG.triggerRemainderRatio || remainderQty >= perBoxCap;
}

// ===== 全量产品定制箱优化方案 =====

/**
 * 全量产品定制箱优化方案 - 主入口
 * 不使用已有箱型，基于所有SKU的尺寸/数量/包装属性反向设计定制箱
 * @param {Array} allSkus - 所有SKU [{ name, dimensions:{length,width,height}, quantity, packagingType, softTolerance }]
 * @param {number} gap - 间隙(cm)
 * @param {number} maxSide - 最大边长(cm)
 * @param {number} wallThickness - 壁厚(cm)
 * @returns {Object} { boxTypes: Array, summary: Object }
 */
function generateCustomBoxPlan(allSkus, gap, maxSide, wallThickness) {
    gap = gap || CONFIG.defaultGap;
    maxSide = maxSide || CONFIG.maxSide;
    wallThickness = wallThickness || CONFIG.defaultWallThickness;

    // Step 1: 分离硬/软包装
    const hardSkus = allSkus.filter(s => (s.packagingType || 'hard') === 'hard')
        .map(s => ({ name: s.name, dims: s.dimensions, qty: s.quantity, packagingType: 'hard' }));
    const softSkus = allSkus.filter(s => s.packagingType === 'soft')
        .map(s => ({ name: s.name, dims: s.dimensions, qty: s.quantity, packagingType: 'soft', softTolerance: s.softTolerance || 0 }));

    // 硬包装按体积降序
    hardSkus.sort((a, b) => dimsVolume(b.dims) - dimsVolume(a.dims));

    const boxTypes = [];
    const softUsed = {}; // { skuName: allocatedQty }

    // Step 2: 为每个硬包装SKU设计单SKU专用箱，尝试吸收软包装
    let boxIdx = 0;
    const boxLabels = ['A', 'B', 'C', 'D', 'E', 'F'];

    for (const hSku of hardSkus) {
        const basePlan = _designSingleHardBox(hSku, gap, maxSide);
        if (!basePlan) continue;

        // 尝试主动设计冗余空间吸收软包装
        const merged = _tryMergeSoftIntoHard(basePlan, softSkus, softUsed, maxSide);
        if (merged) {
            const label = boxLabels[boxIdx] || String.fromCharCode(65 + boxIdx);
            merged.boxId = label;
            boxTypes.push(merged);
            boxIdx++;
        } else {
            // 无法吸收软包装，保持单SKU专用箱
            const label = boxLabels[boxIdx] || String.fromCharCode(65 + boxIdx);
            basePlan.boxId = label;
            basePlan.positioning = '单SKU专用定制箱';
            basePlan.designRationale = _genRationaleSingleHard(basePlan);
            basePlan.volumeOptimization = _genVolumeOptSingleHard(basePlan);
            basePlan.mixSkus = [];
            boxTypes.push(basePlan);
            boxIdx++;
        }
    }

    // Step 3: 剩余软包装 → 软包装混装箱
    const remainingSoft = softSkus.filter(s => (softUsed[s.name] || 0) < s.qty)
        .map(s => ({ ...s, remainingQty: s.qty - (softUsed[s.name] || 0) }));

    if (remainingSoft.length > 0) {
        const softBox = _designSoftMixedBoxAll(remainingSoft, gap, maxSide);
        if (softBox) {
            const label = boxLabels[boxIdx] || String.fromCharCode(65 + boxIdx);
            softBox.boxId = label;
            softBox.positioning = '软包装混装定制箱';
            boxTypes.push(softBox);
            boxIdx++;
        }
    }

    // Step 4: 汇总
    const summary = _genSummary(boxTypes, wallThickness);
    return { boxTypes, summary };
}

/**
 * 为单个硬包装SKU设计专用箱
 */
function _designSingleHardBox(sku, gap, maxSide) {
    const d = sku.dims;
    const targetQty = sku.qty;
    const orientations = generateOrientations(d);
    let best = null;

    for (const orient of orientations) {
        const footprintL = orient.length + ADJUST_HARD;
        const footprintW = orient.width + ADJUST_HARD;
        if (footprintL > maxSide || footprintW > maxSide) continue;

        const maxStack = Math.floor((maxSide - ADJUST_HARD) / orient.height);
        if (maxStack <= 0) continue;

        for (let n = 1; n <= maxStack; n++) {
            const extH = n * orient.height + ADJUST_HARD;
            if (extH > maxSide) continue;

            const boxes = Math.ceil(targetQty / n);
            const isExact = targetQty % n === 0;
            const emptySpace = boxes * n - targetQty;
            const tailQty = isExact ? 0 : targetQty - (boxes - 1) * n;

            let score = 0;
            if (isExact) score += 10000;
            // 优先满足 ≥5 箱（免配置费门槛），这是最高优先级
            if (boxes >= CONFIG.defaultMinBoxes) {
                score += 50000;
                // 在满足≥5箱的前提下，轻微倾向箱数更少（装得更紧密）
                score += Math.max(0, 100 - boxes);
            } else {
                // 达不到5箱时，箱数越多越好（接近5箱门槛）
                score += boxes * 1000;
            }
            // 空箱率惩罚
            score -= emptySpace * 20;

            const extL = +(orient.length + ADJUST_HARD).toFixed(1);
            const extW = +(orient.width + ADJUST_HARD).toFixed(1);
            const extHval = +(n * orient.height + ADJUST_HARD).toFixed(1);

            if (score > (best ? best.score : -Infinity)) {
                best = {
                    score,
                    type: 'hard',
                    mainSku: sku.name,
                    productDims: dimsClone(d),
                    orientation: dimsClone(orient),
                    orientationLabel: _getOrientationDesc(orient, d),
                    externalDims: dims(extL, extW, extHval),
                    internalNeeds: dims(orient.length, orient.width, +(n * orient.height).toFixed(1)),
                    perBoxCount: n,
                    boxCount: boxes,
                    hasTail: !isExact,
                    tailQty: tailQty,
                    maxSideOk: Math.max(extL, extW, extHval) <= maxSide,
                    maxSideValue: Math.max(extL, extW, extHval),
                };
            }
        }
    }

    return best;
}

/**
 * 尝试在硬包装箱中主动设计冗余空间吸收软包装
 * 核心逻辑：在不超60cm前提下，尝试在硬包装箱的某个方向增加2.5cm/5cm/7.5cm
 */
function _tryMergeSoftIntoHard(hardPlan, softSkus, softUsed, maxSide) {
    const ext = hardPlan.externalDims;
    const orient = hardPlan.orientation;
    const perBox = hardPlan.perBoxCount;

    // 找一个有剩余数量的软包装SKU
    const availableSoft = softSkus.filter(s => (softUsed[s.name] || 0) < s.qty);
    if (availableSoft.length === 0) return null;

    // 尝试在宽度/长度方向增加 2.5cm、5cm、7.5cm
    const increments = [2.5, 5.0, 7.5];
    const dimNames = ['width', 'length', 'height'];

    for (const dim of dimNames) {
        for (const inc of increments) {
            const newExt = { ...ext };
            newExt[dim] = +(ext[dim] + inc).toFixed(1);

            if (newExt.length > maxSide || newExt.width > maxSide || newExt.height > maxSide) continue;

            // 计算新增空间能塞多少软包装
            // 新增空间尺寸 = inc × 另外两个方向的尺寸
            const otherDims = dimNames.filter(d => d !== dim);
            const spaceL = dim === 'length' ? inc : newExt[otherDims[0]];
            const spaceW = dim === 'width' ? inc : newExt[otherDims[1]];
            const spaceH = dim === 'height' ? inc : Math.max(ext.height, newExt.height - ext.height);

            // 判断软包装能否放入新增空间
            const softAlloc = _calcSoftFitInSpace(availableSoft, softUsed, spaceL, spaceW, spaceH, maxSide, hardPlan);
            if (softAlloc && softAlloc.totalAlloc > 0) {
                // 构建混合箱方案
                return _buildHardMixedBox(hardPlan, newExt, softAlloc, dim, inc, maxSide);
            }
        }
    }

    return null;
}

/**
 * 计算软包装能否放入指定新增空间
 */
function _calcSoftFitInSpace(availableSoft, softUsed, spaceL, spaceW, spaceH, maxSide, hardPlan) {
    const allocs = [];
    let totalAlloc = 0;

    for (const soft of availableSoft) {
        const remaining = soft.qty - (softUsed[soft.name] || 0);
        if (remaining <= 0) continue;

        // 软包装压缩尺寸
        const sd = soft.dims;
        const cL = Math.max(0.1, sd.length - SOFT_COMPRESS);
        const cW = Math.max(0.1, sd.width - SOFT_COMPRESS);
        const cH = Math.max(0.1, sd.height - SOFT_COMPRESS);

        // 尝试每种朝向
        const orients = generateOrientations(dims(cL, cW, cH));
        let bestFit = 0;
        let bestOrient = null;

        for (const o of orients) {
            if (o.length > spaceL || o.width > spaceW || o.height > spaceH) {
                // 尝试旋转180度（交换长宽）
                if (o.width > spaceL || o.length > spaceW || o.height > spaceH) continue;
                // 交换长宽
                const nFit = Math.floor(spaceL / o.width) * Math.floor(spaceW / o.length) * Math.floor(spaceH / o.height);
                if (nFit > bestFit) {
                    bestFit = nFit;
                    bestOrient = o;
                }
            } else {
                const nFit = Math.floor(spaceL / o.length) * Math.floor(spaceW / o.width) * Math.floor(spaceH / o.height);
                if (nFit > bestFit) {
                    bestFit = nFit;
                    bestOrient = o;
                }
            }
        }

        if (bestFit > 0 && bestOrient) {
            const boxes = hardPlan.boxCount;
            const maxTotal = bestFit * boxes;
            const totalFromThis = Math.min(maxTotal, remaining);
            if (totalFromThis <= 0) continue;
            const qtyPerBox = Math.ceil(totalFromThis / boxes);
            allocs.push({
                skuName: soft.name,
                qtyPerBox,
                totalAlloc: totalFromThis,
                orientation: bestOrient,
            });
            totalAlloc += totalFromThis;
            softUsed[soft.name] = (softUsed[soft.name] || 0) + totalFromThis;
        }
    }

    if (totalAlloc === 0) return null;

    return { allocs, totalAlloc };
}

/**
 * 构建硬包装主导混装箱
 */
function _buildHardMixedBox(hardPlan, newExt, softAlloc, expandedDim, increment, maxSide) {
    const perBox = hardPlan.perBoxCount;
    const boxes = hardPlan.boxCount;

    const mixSkuList = softAlloc.allocs.map(a => ({
        skuName: a.skuName,
        qtyPerBox: a.qtyPerBox,
    }));

    const perBoxStructure = [
        { skuName: hardPlan.mainSku, qty: perBox },
        ...softAlloc.allocs.map(a => ({
            skuName: a.skuName,
            qty: a.qtyPerBox,
        })),
    ];

    const designRationale = [
        `${hardPlan.mainSku} 为硬包装产品，决定基础箱型`,
        `采用「${hardPlan.orientationLabel}」摆放，底面 ${hardPlan.orientation.length}×${hardPlan.orientation.width}cm`,
        `在${expandedDim === 'width' ? '宽度' : expandedDim === 'length' ? '长度' : '高度'}方向主动增加 ${increment}cm 冗余空间`,
        `用于吸收软包装产品，减少额外箱数`,
        ...softAlloc.allocs.map(a =>
            `每箱混装 ${a.skuName} × ${a.qtyPerBox}个，${boxes}箱共吸收 ${a.totalAlloc}个`
        ),
    ];

    const volumeOpt = [
        `定制箱尺寸围绕 ${hardPlan.mainSku} 反推，不使用已有箱型`,
        `${expandedDim === 'width' ? '宽度' : expandedDim === 'length' ? '长度' : '高度'}增加 ${increment}cm 用于吸收软包装`,
        `相比单独为软包装设计箱子，减少了总箱数`,
    ];

    const riskTips = [
        '需确认供应商标注的是纸箱外径还是内径',
        '软包装不能过度挤压导致外箱鼓包',
        '不能压坏硬包装产品',
    ];
    if (newExt.length > 58 || newExt.width > 58 || newExt.height > 58) {
        riskTips.push(`最长边 ${Math.max(newExt.length, newExt.width, newExt.height)}cm 接近 60cm 限制`);
    }

    const maxSideVal = Math.max(newExt.length, newExt.width, newExt.height);

    return {
        type: 'hard_mixed',
        mainSku: hardPlan.mainSku,
        productDims: hardPlan.productDims,
        externalDims: newExt,
        internalNeeds: hardPlan.internalNeeds,
        orientationLabel: hardPlan.orientationLabel,
        perBoxCount: perBox,
        boxCount: boxes,
        hasTail: hardPlan.hasTail,
        tailQty: hardPlan.tailQty,
        perBoxStructure,
        mixSkus: mixSkuList,
        maxSideOk: maxSideVal <= maxSide,
        maxSideValue: maxSideVal,
        designRationale,
        volumeOptimization: volumeOpt,
        riskTips,
        positioning: '硬包装主导混装定制箱',
        softSpaceNote: `${expandedDim === 'width' ? '宽度' : expandedDim === 'length' ? '长度' : '高度'}方向增加 ${increment}cm 用于软包装填充`,
    };
}

/**
 * 软包装混装箱
 */
function _designSoftMixedBoxAll(softSkus, gap, maxSide) {
    const totalQty = softSkus.reduce((s, sku) => s + sku.remainingQty, 0);
    if (totalQty === 0) return null;

    const maxDims = softSkus.reduce((acc, sku) => ({
        length: Math.max(acc.length, Math.max(0.1, sku.dims.length - SOFT_COMPRESS)),
        width: Math.max(acc.width, Math.max(0.1, sku.dims.width - SOFT_COMPRESS)),
        height: Math.max(acc.height, Math.max(0.1, sku.dims.height - SOFT_COMPRESS)),
    }), { length: 0, width: 0, height: 0 });

    const orientations = generateOrientations(maxDims);
    let best = null;

    for (const orient of orientations) {
        const maxStack = Math.floor((maxSide - ADJUST_SOFT) / orient.height);
        if (maxStack <= 0) continue;

        // 每个朝向只取最大堆叠数（最少箱数），不需要内层循环
        const n = Math.min(maxStack, totalQty);
        const extH = n * orient.height + ADJUST_SOFT;
        const extL = orient.length + ADJUST_SOFT;
        const extW = orient.width + ADJUST_SOFT;
        if (extL > maxSide || extW > maxSide || extH > maxSide) continue;

        const boxes = Math.ceil(totalQty / n);
        const maxSideVal = Math.max(extL, extW, extH);

        // 精确分配每箱各SKU数量，不超过箱容量 n
        const perBoxStructure = [];
        let remainCap = n;
        for (const s of softSkus) {
            const idealPerBox = Math.ceil(s.remainingQty / boxes);
            const qty = Math.min(idealPerBox, remainCap);
            if (qty <= 0) break;
            perBoxStructure.push({ skuName: s.name, qty });
            remainCap -= qty;
        }

        // mixSkus 使用相同逻辑
        const mixSkus = perBoxStructure.map(s => ({ skuName: s.skuName, qtyPerBox: s.qty }));

        const result = {
            type: 'soft_mixed',
            mainSku: '软包装合箱',
            externalDims: dims(+(extL).toFixed(1), +(extW).toFixed(1), +(extH).toFixed(1)),
            internalNeeds: dims(orient.length, orient.width, +(n * orient.height).toFixed(1)),
            orientationLabel: _getOrientationDesc(orient, maxDims),
            perBoxCount: n,
            boxCount: boxes,
            hasTail: false,
            perBoxStructure,
            mixSkus,
            maxSideOk: maxSideVal <= maxSide,
            maxSideValue: maxSideVal,
            designRationale: [
                `软包装 SKU 共 ${softSkus.length} 款，合计 ${totalQty} 个`,
                `按最大尺寸 ${maxDims.length}×${maxDims.width}×${maxDims.height}cm 估算`,
                `每箱装 ${n} 个，共 ${boxes} 箱`,
            ],
            volumeOptimization: [
                '软包装可轻微压缩，箱内空间利用率较高',
                '如软包装尺寸差异较大，可考虑分箱装运',
            ],
            riskTips: [
                '软包装可轻微压缩，装箱时注意不要过度挤压',
                '避免外箱鼓包',
                '如果实际产品尺寸差异较大，建议分箱装运',
            ],
            positioning: '软包装混装定制箱',
        };

        // 择优：≥5箱（免配置费门槛）优先，同条件箱数更少优先
        const isQualified = boxes >= CONFIG.defaultMinBoxes;
        const isBestQualified = best && best.boxCount >= CONFIG.defaultMinBoxes;
        if (!best ||
            (isQualified && !isBestQualified) ||           // 达标 > 未达标
            (isQualified === isBestQualified && boxes < best.boxCount) ||  // 同档比箱数
            (isQualified === isBestQualified && boxes === best.boxCount && maxSideVal < best.maxSideValue)) {
            best = result;
        }
    }

    return best;
}

/**
 * 生成单SKU专用箱的设计理由
 */
function _genRationaleSingleHard(plan) {
    const d = plan.productDims;
    const ext = plan.externalDims;
    return [
        `${plan.mainSku} 为硬包装产品，尺寸较大（${d.length}×${d.width}×${d.height}cm），应优先满足其底面尺寸`,
        `采用「${plan.orientationLabel}」摆放，${plan.perBoxCount}个叠放高度 ${plan.orientation.height}×${plan.perBoxCount} = ${plan.internalNeeds.height}cm`,
        `定制箱尺寸围绕该SKU反推，不使用已有箱型`,
        `外箱尺寸在理论内径需求（${plan.internalNeeds.length}×${plan.internalNeeds.width}×${plan.internalNeeds.height}cm）基础上加入最小余量和纸箱厚度修正`,
        plan.hasTail
            ? `共 ${plan.boxCount} 箱，其中 ${plan.boxCount - 1} 箱标准箱 + 1 箱尾箱（${plan.tailQty}个）`
            : `${plan.perBoxCount}个/箱 × ${plan.boxCount}箱，恰好装完`,
    ];
}

/**
 * 生成单SKU专用箱的体积优化说明
 */
function _genVolumeOptSingleHard(plan) {
    return [
        `箱子围绕该SKU精确设计，不保留大面积空余`,
        plan.hasTail ? `存在尾箱（${plan.tailQty}个），可考虑与软包装混装` : `无需尾箱，全部为标准箱`,
    ];
}

/**
 * 生成汇总
 */
function _genSummary(boxTypes, wallThickness) {
    let totalBoxes = 0;
    let totalVolume = 0;

    for (const bt of boxTypes) {
        totalBoxes += bt.boxCount || 0;
        const v = bt.externalDims ? dimsVolume(bt.externalDims) : 0;
        totalVolume += v * (bt.boxCount || 0);
    }

    return {
        totalBoxes,
        totalVolume: +totalVolume.toFixed(0),
        boxTypeCount: boxTypes.length,
        hasTailBox: boxTypes.some(bt => bt.hasTail),
    };
}
