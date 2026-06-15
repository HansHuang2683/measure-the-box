// ===== 常量 =====
const CONFIG = {
    defaultGap: 0.5,          // cm，产品之间/产品与箱壁的间隙
    defaultWallThickness: 1.0, // cm，纸箱壁厚
    defaultMinBoxes: 5,        // 最少箱数（免配置费门槛）
    maxSide: 60,               // cm，最长边限制（亚马逊+FEDEX/UPS）
    maxSoftTolerance: 0.20,    // 软包装最大压缩公差
    defaultSoftTolerance: 0.10,
    triggerRemainderRatio: 0.30, // 剩余产品比例超过30%才触发定制建议
    maxBoxesToTry: 30,          // 自动分配时尝试的最大箱数
    // 定制箱：产品尺寸→外箱尺寸的总调整量（含安全余量和壁厚修正）
    adjustHard: 1.0,           // 硬包装：各方向+1.0cm
    adjustSoft: 0.0,           // 软包装：各方向0cm（可压缩，不需要正余量）
    softCompress: 2.0,         // 软包装可压缩量(cm)，各方向-2cm
};

// ===== 预置标准箱规（单位：cm；含电商小纸箱、FBA常规箱、扁平飞机盒）=====
const STANDARD_BOX_SIZES = [
    // 电商编号纸箱：12号 → 1号
    [13,8,9], [14.5,8.5,10.5], [17.5,9.5,11.5], [19.5,10.5,13.5],
    [21,11,14], [23,13,16], [26,15,18], [29,17,19],
    [35,19,23], [43,21,27], [53,23,29], [53,29,37],

    // 常见小中号箱
    [25,25,25], [30,25,25], [30,30,20], [30,30,30], [32,14,24],
    [35,35,25], [35,35,35],
    [40,30,20], [40,30,30], [40,40,30], [40,40,40],
    [45,30,25], [45,35,30], [45,35,35], [45,45,35], [45,45,45],
    [50,35,35], [50,40,30], [50,40,40], [50,50,40], [50,50,50],
    [55,40,35], [55,45,41],

    // FBA / FEDEX / UPS 常规箱
    [60,60,60], [60,60,55], [60,60,50], [60,60,45], [60,60,40],
    [60,55,55], [60,55,50], [60,55,45], [60,55,40],
    [60,50,50], [60,50,45], [60,50,40],
    [60,45,45], [60,45,40],
    [60,40,50], [60,40,40], [60,40,30],
    [65,45,45], [70,50,50],
    [55,55,55], [55,55,50], [55,55,45], [55,55,40],
    [55,50,50], [55,50,45], [55,50,40],
    [55,45,45], [55,45,40],
    [55,40,40],
    [50,50,45],
    [50,45,45], [50,45,40],
    [45,45,40],
    [45,40,40],

    // 扁平飞机盒
    [50,40,6], [50,30,6], [45,35,7], [42,33,7],
    [40,30,8], [40,30,6], [36,25,10], [36,30,6],
];

// ===== Packing Factors =====
const PACKING_FACTORS = {
    single_hard: 0.90,
    single_soft: 0.95,
    mixed_hard: 0.65,
    mixed_soft: 0.75,
    mixed_hard_soft: 0.75,
};

// ===== 结果状态 =====
const PACKING_STATUS = {
    VERIFIED: 'verified_fit',
    ESTIMATED: 'estimated_fit',
    FAILED_LEVEL: 'level_pack_failed',
    IMPOSSIBLE: 'impossible',
};

// ===== 工具函数 =====
function dims(l, w, h) { return { length: l, width: w, height: h }; }

function dimsVolume(d) { return d.length * d.width * d.height; }

function dimsClone(d) { return { length: d.length, width: d.width, height: d.height }; }



// ===== 生成6种摆放方向 =====
// 输入 {length, width, height}，输出6种排列
function generateOrientations(d) {
    const [a, b, c] = [d.length, d.width, d.height];
    // 所有6种排列
    return [
        dims(a, b, c),
        dims(a, c, b),
        dims(b, a, c),
        dims(b, c, a),
        dims(c, a, b),
        dims(c, b, a),
    ];
}

// ===== I18n 中文 =====
// 预留国际化支持（当前只有中文）
