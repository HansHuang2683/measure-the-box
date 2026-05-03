// ===== 多箱分配算法 =====

/**
 * 将产品均匀分配到N个箱子
 * @param {number} totalQty - 产品总数量
 * @param {number} perBoxCapacity - 每箱容量
 * @param {number} minBoxes - 最少箱数（默认5）
 * @returns {Object} { distribution, totalBoxes, remaining, perBoxBase }
 */
function distributeEvenly(totalQty, perBoxCapacity, minBoxes) {
    minBoxes = minBoxes || CONFIG.defaultMinBoxes;
    if (!perBoxCapacity || perBoxCapacity <= 0) {
        return { distribution: [], totalBoxes: 0, remaining: totalQty, perBoxBase: 0 };
    }

    const boxesNeeded = Math.max(minBoxes, Math.ceil(totalQty / perBoxCapacity));
    const basePerBox = Math.floor(totalQty / boxesNeeded);
    const remainder = totalQty % boxesNeeded;

    const distribution = [];
    for (let i = 0; i < boxesNeeded; i++) {
        distribution.push(i < remainder ? basePerBox + 1 : basePerBox);
    }

    return {
        distribution,
        totalBoxes: boxesNeeded,
        remaining: Math.max(0, totalQty - boxesNeeded * perBoxCapacity),
        perBoxBase: basePerBox,
        requiresMinBoxWarning: boxesNeeded < minBoxes,
    };
}


