// ===== 单SKU装箱算法 =====
// 计算同一款产品装一箱时的最优方案

/**
 * 计算单个箱子能装多少件产品
 * @param {Object} boxInternal - {length, width, height} 箱内径(cm)
 * @param {Object} productDims - {length, width, height} 产品外箱尺寸(cm)
 * @param {number} gap - 间隙(cm)，默认0.5
 * @returns {Object|null} { orientation, arrangement, perBoxCount, volumeUtilization } 或 null
 */
function calcSingleSKUPacking(boxInternal, productDims, gap) {
    gap = gap || CONFIG.defaultGap;
    const boxVol = dimsVolume(boxInternal);
    const orientations = generateOrientations(productDims);
    let best = null;

    for (const orient of orientations) {
        const countL = Math.floor((boxInternal.length - gap) / (orient.length + gap));
        const countW = Math.floor((boxInternal.width - gap) / (orient.width + gap));
        const countH = Math.floor((boxInternal.height - gap) / (orient.height + gap));

        if (countL <= 0 || countW <= 0 || countH <= 0) continue;

        const total = countL * countW * countH;
        const productVol = dimsVolume(productDims);
        const utilization = (total * productVol) / boxVol;

        if (!best || total > best.perBoxCount ||
            (total === best.perBoxCount && utilization > best.volumeUtilization)) {
            best = {
                orientation: dimsClone(orient),
                arrangement: { alongLength: countL, alongWidth: countW, alongHeight: countH },
                perBoxCount: total,
                volumeUtilization: utilization,
            };
        }
    }

    return best;
}

/**
 * 对多个SKU分别计算各自最优的单箱容量
 * @param {Array} skus - SKU数组，每个含 dimensions 和 softTolerance
 * @param {Object} boxInternal - 箱内径
 * @param {number} gap
 * @returns {Object} { skuId: packingResult }
 */
function calcAllSKUsInBox(skus, boxInternal, gap) {
    const results = {};
    for (const sku of skus) {
        const effectiveDims = getEffectiveDimensions(sku);
        results[sku.id] = calcSingleSKUPacking(boxInternal, effectiveDims, gap);
    }
    return results;
}

/**
 * 获取SKU的有效尺寸（考虑软包装公差）
 */
function getEffectiveDimensions(sku) {
    if (sku.packagingType === 'soft') {
        // 用户自定义公差 > 0 → 百分比立方缩放
        if (sku.softTolerance && sku.softTolerance > 0) {
            const scale = Math.pow(1 - sku.softTolerance, 1 / 3);
            return {
                length: sku.dimensions.length * scale,
                width: sku.dimensions.width * scale,
                height: sku.dimensions.height * scale,
            };
        }
        // 默认 → -2cm 平减
        const c = CONFIG.softCompress || 2.0;
        return {
            length: Math.max(0.1, sku.dimensions.length - c),
            width: Math.max(0.1, sku.dimensions.width - c),
            height: Math.max(0.1, sku.dimensions.height - c),
        };
    }
    return sku.dimensions;
}

/**
 * 检查产品是否能放入箱子（至少一个方向可行）
 */
function canFitInBox(productDims, boxInternal, gap) {
    gap = gap || CONFIG.defaultGap;
    const orientations = generateOrientations(productDims);
    for (const orient of orientations) {
        if (orient.length + gap <= boxInternal.length &&
            orient.width + gap <= boxInternal.width &&
            orient.height + gap <= boxInternal.height) {
            return true;
        }
    }
    return false;
}
