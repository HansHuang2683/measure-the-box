// ===== XLSX 导入导出 =====
// 使用 SheetJS 库（通过 CDN 加载）

/**
 * 解析 Amazon FBA xlsx 模板，提取 SKU 列表
 * 现场解析，不依赖外部库
 */
function parseAmazonXlsx(buffer) {
    // 要求加载 SheetJS
    if (typeof XLSX === 'undefined') {
        alert('请先加载 SheetJS 库。\n在 index.html 中添加: <script src="https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js"></script>');
        return null;
    }

    try {
        const workbook = XLSX.read(buffer, { type: 'array' });
        const sheetNames = workbook.SheetNames;
        console.log('工作表:', sheetNames);

        // 查找数据表（通常是名称含"包装"或"信息"的sheet）
        const dataSheet = sheetNames.find(n =>
            n.includes('包装') || n.includes('信息') || n.includes('Sheet')
        ) || sheetNames[1] || sheetNames[0];

        const sheet = workbook.Sheets[dataSheet];
        const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

        console.log(`解析到 ${json.length} 行数据`);

        // 尝试找到 SKU 列和数量列
        // 典型格式：第一列是 SKU/商品名称，后面是每箱的数量列
        const result = [];
        let skuCol = -1;

        for (let rowIdx = 0; rowIdx < Math.min(json.length, 10); rowIdx++) {
            const row = json[rowIdx];
            if (!row || row.length === 0) continue;

            // 查找包含 'SKU' 或 '商品' 的列头
            for (let col = 0; col < row.length; col++) {
                const val = String(row[col]).trim();
                if (val.includes('SKU') || val.includes('商品') || val.includes('FNSKU')) {
                    skuCol = col;
                }
            }
        }

        if (skuCol === -1) {
            // 尝试找有产品名称的列
            let found = false;
            for (let rowIdx = 2; rowIdx < json.length; rowIdx++) {
                const row = json[rowIdx];
                if (!row || row.length < 2) continue;
                const name = String(row[1] || row[0] || '').trim();
                // Amazon 模板常见格式
                if (name && name.length > 2 && !name.startsWith('Packing')) {
                    const skuName = String(row[0] || '').trim();
                    // 找数量：通常在后面的列中（合计列）
                    let totalQty = 0;
                    // 找"数量"或"Quantity"列
                    // 简单策略：取第一个数字较大的列
                    for (let c = 3; c < Math.min(row.length, 20); c++) {
                        const v = parseFloat(row[c]);
                        if (!isNaN(v) && v > 0 && v < 10000) {
                            totalQty += v;
                        }
                    }
                    if (totalQty > 0 && skuName) {
                        result.push({ name: skuName, quantity: totalQty });
                        found = true;
                    }
                }
            }

            if (found) return result;
        }

        // Fallback: 直接提示
        alert('无法自动识别 xlsx 格式。请在界面上手动输入 SKU 数据。');
        return null;

    } catch (e) {
        console.error('xlsx 解析失败:', e);
        alert('xlsx 文件解析失败: ' + e.message);
        return null;
    }
}

/**
 * 生成简单的 xlsx 导出文件
 * 实际使用 SheetJS 库
 */
function generateSimpleXlsx(skus, boxTypes, mixedGroups) {
    if (typeof XLSX === 'undefined') {
        // Fallback to CSV
        let csv = 'SKU,箱子类型,箱号,每箱数量,长(cm),宽(cm),高(cm)\n';

        for (const group of mixedGroups) {
            const bt = boxTypes.find(b => b.id === group.boxTypeId);
            for (let i = 0; i < group.boxCount; i++) {
                const boxLabel = `${group.name} #${i + 1}`;
                for (const asgn of group.assignments) {
                    const sku = skus.find(s => s.id === asgn.skuId);
                    if (!sku) continue;
                    csv += `"${sku.name}","${bt ? bt.name : ''}","${boxLabel}",${asgn.qtyPerBox},${sku.dimensions.length},${sku.dimensions.width},${sku.dimensions.height}\n`;
                }
            }
        }

        // 追加全量产品定制箱优化方案
        csv += '\n\n全量产品定制箱优化方案\n';
        csv += '定制箱型,箱型定位,主SKU,辅助/混装SKU,推荐外箱尺寸,理论内径需求,每箱装入结构,预计箱数,是否有尾箱,摆放方向,≤60cm\n';
        const plan_csv = generateCustomBoxPlan(skus);
        if (plan_csv && plan_csv.boxTypes) {
            for (const box of plan_csv.boxTypes) {
                const ext = box.externalDims || {};
                const intN = box.internalNeeds || {};
                const perBoxStr = (box.perBoxStructure || []).map(s => s.skuName + '×' + s.qty).join('+') || (box.mainSku + '×' + box.perBoxCount);
                const mixStr = (box.mixSkus || []).map(m => m.skuName + '×' + m.qtyPerBox).join('、') || '无';
                csv += `"定制箱${box.boxId || ''}","${box.positioning || '—'}","${box.mainSku || '—'}","${mixStr}","${formatDims(ext)}cm","${formatDims(intN)}cm","${perBoxStr}",${box.boxCount || 0},"${box.hasTail ? '是' : '否'}","${box.orientationLabel || '—'}","${box.maxSideOk ? '是' : '否'}:${box.maxSideValue}cm"\n`;
            }
        }

        // Download CSV
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '装箱方案.csv';
        a.click();
        URL.revokeObjectURL(url);
        return;
    }

    // SheetJS 导出
    try {
        const data = [['混装组', '箱号', '箱型', 'SKU', '每箱数量', '长(cm)', '宽(cm)', '高(cm)']];

        for (const group of mixedGroups) {
            const bt = boxTypes.find(b => b.id === group.boxTypeId);
            for (let i = 0; i < group.boxCount; i++) {
                for (const asgn of group.assignments) {
                    const sku = skus.find(s => s.id === asgn.skuId);
                    if (!sku) continue;
                    data.push([
                        group.name,
                        `箱#${i + 1}`,
                        bt ? bt.name : '',
                        sku.name,
                        asgn.qtyPerBox,
                        sku.dimensions.length,
                        sku.dimensions.width,
                        sku.dimensions.height,
                    ]);
                }
            }
        }

        const ws = XLSX.utils.aoa_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '装箱方案');

        // 添加汇总表
        const summaryData = [['SKU', '总数量', '已装箱', '剩余', '包装类型']];
        for (const sku of skus) {
            let used = 0;
            for (const group of mixedGroups) {
                const asgn = group.assignments.find(a => a.skuId === sku.id);
                if (asgn) used += asgn.qtyPerBox * group.boxCount;
            }
            summaryData.push([
                sku.name, sku.quantity, used,
                Math.max(0, sku.quantity - used),
                sku.packagingType === 'soft' ? `软(${Math.round(sku.softTolerance * 100)}%)` : '硬'
            ]);
        }
        const ws2 = XLSX.utils.aoa_to_sheet(summaryData);
        XLSX.utils.book_append_sheet(wb, ws2, '汇总');

        // 添加定制箱建议表
        _addCustomBoxSheet(wb, skus, mixedGroups);

        XLSX.writeFile(wb, 'FBA装箱方案.xlsx');
    } catch (e) {
        console.error('xlsx 导出失败:', e);
        alert('导出失败: ' + e.message);
    }
}

/**
 * 添加全量产品定制箱优化方案 worksheet
 */
function _addCustomBoxSheet(wb, skus, mixedGroups) {
    const plan = generateCustomBoxPlan(skus);
    if (!plan || !plan.boxTypes || plan.boxTypes.length === 0) return;

    const rows = [['定制箱型', '箱型定位', '主SKU', '辅助/混装SKU', '推荐外箱尺寸', '理论内径需求', '每箱装入结构', '预计箱数', '是否有尾箱', '摆放方向', '≤60cm']];

    for (const box of plan.boxTypes) {
        const ext = box.externalDims || {};
        const intN = box.internalNeeds || {};
        const perBoxStr = (box.perBoxStructure || []).map(s => s.skuName + '×' + s.qty).join('+') || box.mainSku + '×' + box.perBoxCount;
        const mixStr = (box.mixSkus || []).map(m => m.skuName + '×' + m.qtyPerBox).join('、') || '无';

        rows.push([
            '定制箱' + (box.boxId || ''),
            box.positioning || '—',
            box.mainSku || '—',
            mixStr,
            formatDims(ext) + ' cm',
            formatDims(intN) + ' cm',
            perBoxStr,
            String(box.boxCount || 0),
            box.hasTail ? '是' : '否',
            box.orientationLabel || '—',
            box.maxSideOk ? '是(最长边' + box.maxSideValue + 'cm)' : '否(最长边' + box.maxSideValue + 'cm)',
        ]);
    }

    // 添加设计理由和风险提示
    rows.push([]);
    rows.push(['说明']);
    for (const box of plan.boxTypes) {
        if (box.designRationale && box.designRationale.length > 0) {
            rows.push(['定制箱' + (box.boxId || '') + '设计理由:']);
            for (const r of box.designRationale) {
                rows.push(['', r]);
            }
        }
        if (box.riskTips && box.riskTips.length > 0) {
            rows.push(['定制箱' + (box.boxId || '') + '风险提示:']);
            for (const t of box.riskTips) {
                rows.push(['', '⚠️ ' + t]);
            }
        }
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, '定制箱优化方案');
}

// 挂载到全局
window.processXlsxFile = function (file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        const data = new Uint8Array(e.target.result);
        const skuData = parseAmazonXlsx(data);
        if (skuData && skuData.length > 0) {
            // 清空现有 SKU
            document.querySelectorAll('#skuBody tr').forEach(tr => tr.remove());
            // 填充导入的 SKU
            for (const item of skuData) {
                addSkuRow({ name: item.name, qty: String(item.quantity) });
            }
            updateDataFromTables();
            alert(`成功导入 ${skuData.length} 个 SKU`);
        }
    };
    reader.readAsArrayBuffer(file);
};

window.generateXlsx = function (skus, boxTypes, mixedGroups) {
    generateSimpleXlsx(skus, boxTypes, mixedGroups);
};
