// ===== Three.js 3D 渲染器 =====
let scene, camera, renderer, controls;
let viewerReady = false;
let animFrameId = null;

// SKU 颜色
const SKU_COLORS = [
    0x4285f4, 0xea4335, 0x34a853, 0xfbbc05, 0x8e24aa,
    0x00bcd4, 0xff5722, 0x795548, 0x607d8b, 0x9c27b0,
];
function getSkuColor(idx) { return SKU_COLORS[idx % SKU_COLORS.length]; }

// ===== 入口：确保 Three.js 已加载再初始化 =====
function ensureViewer(callback) {
    if (viewerReady && scene) {
        callback();
        return;
    }
    if (typeof THREE !== 'undefined') {
        initViewer(callback);
        return;
    }
    // Three.js 未加载，动态加载
    const container = document.getElementById('viewer-container');
    if (!container) return;
    container.innerHTML = '<div class="loading">⏳ 正在加载 3D 引擎...</div>';
    loadThree(() => initViewer(callback));
}

function loadThree(onDone) {
    function loadOrbitControls(afterLoaded) {
        const ctrl = document.createElement('script');
        ctrl.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js';
        ctrl.onload = afterLoaded;
        ctrl.onerror = () => {
            const fallback = document.createElement('script');
            fallback.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/examples/js/controls/OrbitControls.js';
            fallback.onload = afterLoaded;
            fallback.onerror = () => showViewerError('3D 控件加载失败');
            document.head.appendChild(fallback);
        };
        document.head.appendChild(ctrl);
    }
    function loadDragControls(afterLoaded) {
        const dc = document.createElement('script');
        dc.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/DragControls.js';
        dc.onload = afterLoaded;
        dc.onerror = () => {
            const fallback = document.createElement('script');
            fallback.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/examples/js/controls/DragControls.js';
            fallback.onload = afterLoaded;
            fallback.onerror = () => showViewerError('DragControls 加载失败');
            document.head.appendChild(fallback);
        };
        document.head.appendChild(dc);
    }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
    script.onload = () => loadOrbitControls(() => loadDragControls(onDone));
    script.onerror = () => {
        const retry = document.createElement('script');
        retry.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js';
        retry.onload = () => loadOrbitControls(() => loadDragControls(onDone));
        retry.onerror = () => showViewerError('3D 库加载失败，请检查网络连接');
        document.head.appendChild(retry);
    };
    document.head.appendChild(script);
}

function showViewerError(msg) {
    const container = document.getElementById('viewer-container');
    if (container) container.innerHTML = `<div class="viewer-empty">⚠️ ${msg}</div>`;
}

// ===== 初始化 Three.js 场景 =====
function initViewer(callback) {
    const container = document.getElementById('viewer-container');
    if (!container) return;

    // 清理旧的渲染器
    if (renderer) {
        renderer.dispose();
        renderer = null;
    }
    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
    container.innerHTML = '';

    const rect = container.getBoundingClientRect();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f7fa);

    camera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.1, 1000);
    camera.position.set(4, 3, 5);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(rect.width, rect.height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    // OrbitControls
    if (typeof THREE.OrbitControls !== 'undefined') {
        controls = new THREE.OrbitControls(camera, renderer.domElement);
    } else if (typeof OrbitControls !== 'undefined') {
        controls = new OrbitControls(camera, renderer.domElement);
    }
    if (controls) {
        controls.enableDamping = true;
        controls.dampingFactor = 0.1;
        controls.minDistance = 0.5;
        controls.maxDistance = 20;
    }

    // 灯光
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dl = new THREE.DirectionalLight(0xffffff, 0.8);
    dl.position.set(5, 10, 7);
    scene.add(dl);
    const bl = new THREE.DirectionalLight(0xffffff, 0.3);
    bl.position.set(-3, 2, -5);
    scene.add(bl);

    // 网格
    const grid = new THREE.GridHelper(8, 8, 0xcccccc, 0xdddddd);
    grid.position.y = -0.01;
    scene.add(grid);

    // 窗口大小变化
    const onResize = () => {
        const r = container.getBoundingClientRect();
        if (camera && renderer && r.width > 0) {
            camera.aspect = r.width / r.height;
            camera.updateProjectionMatrix();
            renderer.setSize(r.width, r.height);
        }
    };
    window.addEventListener('resize', onResize);

    viewerReady = true;
    startAnim();

    if (callback) callback();
}

function startAnim() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    function loop() {
        animFrameId = requestAnimationFrame(loop);
        if (controls) controls.update();
        if (renderer && scene && camera) renderer.render(scene, camera);
    }
    loop();
}

// ===== 渲染混装组的某个箱子 =====
function loadGroupIntoViewer(group, boxType, result, boxIndex, cavities) {
    ensureViewer(() => renderGroup(group, boxType, result, boxIndex, cavities));
}

function renderGroup(group, boxType, result, boxIndex, cavities) {
    if (!scene || !renderer) return;

    // 清空腔组
    clearCavities();

    // 清场（保留灯光和网格）
    const keep = [];
    for (const c of scene.children) {
        if (c.type === 'AmbientLight' || c.type === 'DirectionalLight' || c.isGridHelper) {
            keep.push(c);
        }
    }
    while (scene.children.length) scene.remove(scene.children[0]);
    for (const c of keep) scene.add(c);

    const bi = boxType.internal;
    const scale = 1 / Math.max(bi.length, bi.width, bi.height);

    // 使用层架算法选择的箱子朝向（如有）来确定 floor 尺寸
    const boxOrient = (result.layers && result.layers[0] && result.layers[0].boxOrientation) || bi;
    const floorL = boxOrient.length * scale;
    const floorW = boxOrient.width * scale;
    const boxH = boxOrient.height * scale;

    const hasLayout = result.layers && result.layers.length > 0;
    // 箱体线框（使用层架算法选定的朝向，确保产品始终在箱内）
    drawBox(floorL, boxH, floorW, hasLayout ? 0x1a73e8 : 0xe37400);

    // 估算模式加提示文字
    if (!hasLayout) {
        const hint = makeLabelSprite('⚠️ 估算布局（无实际排布数据）');
        hint.position.set(0, boxH + 0.3, 0);
        scene.add(hint);
    }

    // 层架
    if (result.layers && result.layers.length > 0) {
        const skuColorMap = new Map();
        let ci = 0;
        for (const layer of result.layers) {
            for (const p of layer.placements) {
                if (!skuColorMap.has(p.skuId)) skuColorMap.set(p.skuId, getSkuColor(ci++));
            }
            // 空腔堆叠的产品也分配颜色（否则会变成灰色 0x999999）
            for (const s of (layer.stacks || [])) {
                if (!skuColorMap.has(s.skuId)) skuColorMap.set(s.skuId, getSkuColor(ci++));
            }
        }

        for (const layer of result.layers) {
            const yOff = layer.yOffset * scale;
            for (const p of layer.placements) {
                const color = skuColorMap.get(p.skuId) || 0x999999;
                const itemH = (p.height || layer.height) * scale;
                drawProduct(
                    p.length * scale, p.width * scale, itemH,
                    p.x * scale - floorL / 2, yOff, p.y * scale - floorW / 2,
                    color, p.skuName
                );
            }
            // 堆叠的产品（矮产品上面的空气隙中）
            for (const s of (layer.stacks || [])) {
                const color = skuColorMap.get(s.skuId) || 0x999999;
                drawProduct(
                    s.length * scale, s.width * scale, s.height * scale,
                    s.x * scale - floorL / 2, yOff + s.stackBase * scale, s.z * scale - floorW / 2,
                    color, s.skuName
                );
            }
        }
    }

    // 溢出产品（装不下，半透明浮在箱子上面）
    if (result.overflowItems && result.overflowItems.length > 0) {
        const gridCols = Math.max(1, Math.ceil(Math.sqrt(result.overflowItems.length * 2)));
        const gridRows = Math.ceil(result.overflowItems.length / gridCols);
        const cellW = floorL / gridCols;
        const cellD = floorW / gridRows;

        result.overflowItems.forEach((item, idx) => {
            const il = item.dims.length * scale;
            const iw = item.dims.width * scale;
            const ih = item.dims.height * scale;
            if (il <= 0 || iw <= 0 || ih <= 0) return;

            const col = idx % gridCols;
            const row = Math.floor(idx / gridCols);
            const px = -floorL / 2 + col * cellW + (cellW - il) / 2;
            const pz = -floorW / 2 + row * cellD + (cellD - iw) / 2;
            const py = boxH + 0.02;

            const geo = new THREE.BoxGeometry(il, ih, iw);
            const mat = new THREE.MeshPhongMaterial({
                color: 0x4F6EF7, transparent: true, opacity: 0.25,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(px + il / 2, py + ih / 2, pz + iw / 2);
            scene.add(mesh);

            const edges = new THREE.EdgesGeometry(geo);
            const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
                color: 0xff4444, transparent: true, opacity: 0.5,
            }));
            line.position.copy(mesh.position);
            scene.add(line);
        });
    }

    // 产品信息面板（非沙盘模式）
    buildNonSandboxPanel(result, boxOrient);

    // 空腔可视化（仅非沙盘模式）
    if (cavities && cavities.length > 0) {
        drawCavities(cavities, scale, boxOrient);
        // 如果已开启空腔显示，保持可见
        if (cavityGroup) cavityGroup.visible = cavityVisible;
    } else {
        clearCavities();
    }

    // 相机位置
    const dist = Math.max(floorL, floorW, boxH) * 1.8;
    camera.position.set(dist * 0.7, dist * 0.5, dist * 0.7);
    if (controls) {
        controls.target.set(0, boxH / 4, 0);
        controls.update();
    }
}

// ===== 非沙盘产品信息面板 =====

function buildNonSandboxPanel(result, boxOrient) {
    // 移除旧面板
    const old = document.getElementById('nonSandboxPanel');
    if (old) old.remove();

    const container = document.getElementById('viewer-container');
    if (!container || !result.layers || result.layers.length === 0) return;

    // 从 layers 收集产品数据 & 计算占用空间
    const groups = {};
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const layer of result.layers) {
        const yOff = layer.yOffset || 0;
        for (const p of layer.placements || []) {
            if (!groups[p.skuId]) groups[p.skuId] = { name: p.skuName || '未知', orig: p.originalDims, count: 0 };
            groups[p.skuId].count++;
            const x2 = p.x + (p.length || 0);
            const z2 = p.y + (p.width || 0);
            const y2 = yOff + (p.height || layer.height || 0);
            if (p.x < minX) minX = p.x;
            if (x2 > maxX) maxX = x2;
            if (yOff < minY) minY = yOff;
            if (y2 > maxY) maxY = y2;
            if (p.y < minZ) minZ = p.y;
            if (z2 > maxZ) maxZ = z2;
        }
        for (const s of layer.stacks || []) {
            if (!groups[s.skuId]) groups[s.skuId] = { name: s.skuName || '未知', orig: s.originalDims, count: 0 };
            groups[s.skuId].count++;
            const x2 = s.x + (s.length || 0);
            const z2 = s.z + (s.width || 0);
            const y2 = yOff + (s.stackBase || 0) + (s.height || 0);
            if (s.x < minX) minX = s.x;
            if (x2 > maxX) maxX = x2;
            if (yOff < minY) minY = yOff;
            if (y2 > maxY) maxY = y2;
            if (s.z < minZ) minZ = s.z;
            if (z2 > maxZ) maxZ = z2;
        }
    }

    const usedL = Math.max(0, maxX - minX);
    const usedW = Math.max(0, maxZ - minZ);
    const usedH = Math.max(0, maxY - minY);
    const remainingL = Math.max(0, boxOrient.length - usedL);
    const remainingW = Math.max(0, boxOrient.width - usedW);
    const remainingH = Math.max(0, boxOrient.height - usedH);

    // 总件数
    let totalItems = 0;
    for (const g of Object.values(groups)) totalItems += g.count;

    // 构建面板 HTML
    let listHtml = '';
    for (const [skuId, g] of Object.entries(groups)) {
        const dims = g.orig || {};
        const dimsStr = (dims.length != null && dims.width != null && dims.height != null)
            ? `${dims.length}×${dims.width}×${dims.height} cm` : '';
        listHtml += `
            <div class="panel-item">
                <span class="panel-label">${g.name}</span>
                <span class="panel-dims">${dimsStr}</span>
                <span class="panel-qty">×${g.count}</span>
            </div>`;
    }

    const panel = document.createElement('div');
    panel.id = 'nonSandboxPanel';
    panel.className = 'product-panel-common';
    panel.innerHTML = `
        <div class="panel-header">产品清单</div>
        <div class="panel-list">${listHtml}</div>
        <div class="panel-footer">
            <div class="panel-total-dims">外尺寸: ${usedL.toFixed(1)} × ${usedW.toFixed(1)} × ${usedH.toFixed(1)} cm</div>
            <div class="panel-total-count">总件数: ${totalItems}</div>
            <div style="margin-top:8px;padding-top:8px;border-top:1px solid #e8edf5;">
                <div style="font-size:12px;color:#666;font-weight:500;margin-bottom:4px;">箱内剩余</div>
                <div style="font-size:12px;color:#1a73e8;font-family:monospace;">
                    长: ${remainingL.toFixed(1)} cm&nbsp;&nbsp;宽: ${remainingW.toFixed(1)} cm&nbsp;&nbsp;高: ${remainingH.toFixed(1)} cm
                </div>
            </div>
        </div>
    `;
    container.appendChild(panel);
}

// ===== 渲染图元 =====

function drawBox(l, h, w, color) {
    color = color || 0x1a73e8;
    const geo = new THREE.BoxGeometry(l, h, w);
    // 只用线框，不用填充面，避免 z-fighting 闪烁
    const edges = new THREE.EdgesGeometry(geo);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }));
    line.position.set(0, h / 2, 0);
    scene.add(line);
}

function makeLabelSprite(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '24px "Microsoft YaHei", Arial, sans-serif';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(0.8, 0.2, 1);
    return sprite;
}

function drawProduct(pl, pw, ph, px, py, pz, color, name) {
    const geo = new THREE.BoxGeometry(pl, ph, pw);
    const mat = new THREE.MeshPhongMaterial({
        color, transparent: true, opacity: 0.7,
        emissive: color, emissiveIntensity: 0.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(px + pl / 2, py + ph / 2, pz + pw / 2);
    scene.add(mesh);

    const edges = new THREE.EdgesGeometry(geo);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25 }));
    line.position.copy(mesh.position);
    scene.add(line);
}

function showViewerEmpty() {
    if (sandboxActive) exitSandboxMode();
    const container = document.getElementById('viewer-container');
    if (container) {
        container.innerHTML = '<div class="viewer-empty">选择上方下拉菜单中的箱子查看 3D 布局</div>';
    }
    viewerReady = false;
    if (renderer) { renderer.dispose(); renderer = null; }
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    scene = null; camera = null; controls = null;
}

// ===== 3D 交互沙盘 =====

let sandboxActive = false;
let sandboxDragControls = null;
let sandboxItemMeshes = [];
let sandboxSelected = null;
let sandboxSelection = [];   // 多选列表
let sandboxScale = 1;
let sandboxSnapEnabled = true;
let sandbox_mouseDownPos = null;

// 沙盘增强状态
let sandboxMode = 'move';
let sandboxProductPanel = null; // DOM 引用
let sandboxOuterBoxDims = null; // {length,width,height} 原始外箱内径

// Undo/redo
let sandboxUndoStack = [];
let sandboxRedoStack = [];
const SANDBOX_MAX_UNDO = 50;

// Axis mode: 'direction' | 'rotate'
let sandboxAxisMode = 'direction';
let sandboxActiveAxis = null;    // 'x' | 'y' | 'z' | null
let sandboxDragStartPos = null;  // 用于方向模式轴约束拖拽

function enterSandboxMode(items, boxInternal, layers, overflowItems) {
    // 先退出已有沙盘，确保 ensureViewer 能重新初始化场景
    if (sandboxActive) exitSandboxMode();

    const container = document.getElementById('viewer-container');
    if (!container) return;

    // 防御性检查：boxInternal 必须有效
    if (!boxInternal || !boxInternal.length || !boxInternal.width || !boxInternal.height) {
        console.error('enterSandboxMode: invalid boxInternal', boxInternal);
        showViewerEmpty();
        return;
    }

    // 移除非沙盘面板
    const nsPanel = document.getElementById('nonSandboxPanel');
    if (nsPanel) nsPanel.remove();

    const go = () => {
        if (!scene || !renderer) { setTimeout(go, 100); return; }

        sandboxActive = true;
        sandboxMode = 'move';
        sandboxScale = 1 / Math.max(boxInternal.length, boxInternal.width, boxInternal.height);

        // 使用层架算法选择的朝向（如有）确定 floor 尺寸
        const boxOrient = (layers && layers[0] && layers[0].boxOrientation) || boxInternal;
        // sandboxOuterBoxDims 必须用 boxOrient（实际排布使用的朝向），否则剩余空间会算错
        sandboxOuterBoxDims = boxOrient;

        // 清场（保留灯光和网格）
        const keep = [];
        for (const c of scene.children) {
            if (c.type === 'AmbientLight' || c.type === 'DirectionalLight' || c.isGridHelper) {
                keep.push(c);
            }
        }
        while (scene.children.length) scene.remove(scene.children[0]);
        for (const c of keep) scene.add(c);

        // 半透明参考外箱线框
        const refL = boxOrient.length * sandboxScale;
        const refW = boxOrient.width * sandboxScale;
        const refH = boxOrient.height * sandboxScale;
        const boxGeo = new THREE.BoxGeometry(refL, refH, refW);
        const boxEdges = new THREE.EdgesGeometry(boxGeo);
        const boxLine = new THREE.LineSegments(boxEdges, new THREE.LineBasicMaterial({ color: 0x999999, transparent: true, opacity: 0.2 }));
        boxLine.position.set(0, refH / 2, 0);
        scene.add(boxLine);

        // 地板参考网格（5cm 间隔，对齐 1cm 吸附）
        const gridStep = 5 * sandboxScale;
        const gridMat = new THREE.LineBasicMaterial({ color: 0x1a73e8, transparent: true, opacity: 0.07 });
        const gridMatMinor = new THREE.LineBasicMaterial({ color: 0x1a73e8, transparent: true, opacity: 0.03 });
        for (let x = -refL / 2; x <= refL / 2 + 0.001; x += gridStep) {
            const isMajor = Math.abs(Math.round(x / (gridStep * 2)) * (gridStep * 2) - x) < 0.001;
            const mat = isMajor ? gridMat : gridMatMinor;
            const pts = [new THREE.Vector3(x, 0.002, -refW / 2), new THREE.Vector3(x, 0.002, refW / 2)];
            scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
        }
        for (let z = -refW / 2; z <= refW / 2 + 0.001; z += gridStep) {
            const isMajor = Math.abs(Math.round(z / (gridStep * 2)) * (gridStep * 2) - z) < 0.001;
            const mat = isMajor ? gridMat : gridMatMinor;
            const pts = [new THREE.Vector3(-refL / 2, 0.002, z), new THREE.Vector3(refL / 2, 0.002, z)];
            scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
        }

        // 不画外箱！只画产品
        sandboxItemMeshes = [];
        const skuColorMap = new Map();
        let ci = 0;

        // 从 layers 展开所有产品（base placements + stacks）
        const allItems = [];
        for (const layer of layers || []) {
            for (const p of layer.placements || []) {
                if (!skuColorMap.has(p.skuId)) skuColorMap.set(p.skuId, getSkuColor(ci++));
                const yPos = (layer.yOffset || 0) * sandboxScale + (p.height || layer.height) * sandboxScale / 2;
                allItems.push({
                    ...p,
                    _posX: p.x * sandboxScale - (boxOrient.length * sandboxScale) / 2,
                    _posY: yPos,
                    _posZ: p.y * sandboxScale - (boxOrient.width * sandboxScale) / 2,
                });
            }
            for (const s of (layer.stacks || [])) {
                if (!skuColorMap.has(s.skuId)) skuColorMap.set(s.skuId, getSkuColor(ci++));
                const yPos = (layer.yOffset || 0) * sandboxScale + s.stackBase * sandboxScale + s.height * sandboxScale / 2;
                allItems.push({
                    ...s,
                    _posX: s.x * sandboxScale - (boxOrient.length * sandboxScale) / 2,
                    _posY: yPos,
                    _posZ: s.z * sandboxScale - (boxOrient.width * sandboxScale) / 2,
                });
            }
        }

        // 添加溢出产品到沙盘（实体、可拖动）
        let overflowCount = 0;
        if (overflowItems && overflowItems.length > 0) {
            const gridCols = Math.max(1, Math.ceil(Math.sqrt(overflowItems.length * 2)));
            const gridRows = Math.ceil(overflowItems.length / gridCols);
            const cellW = refL / gridCols;
            const cellD = refW / gridRows;

            overflowItems.forEach((item, idx) => {
                const il = item.dims.length * sandboxScale;
                const iw = item.dims.width * sandboxScale;
                const ih = item.dims.height * sandboxScale;
                if (il <= 0 || iw <= 0 || ih <= 0) return;

                if (!skuColorMap.has(item.skuId)) skuColorMap.set(item.skuId, getSkuColor(ci++));

                const col = idx % gridCols;
                const row = Math.floor(idx / gridCols);
                const px = -refL / 2 + col * cellW + (cellW - il) / 2 + il / 2;
                const pz = -refW / 2 + row * cellD + (cellD - iw) / 2 + iw / 2;
                const py = refH + ih / 2 + 0.05;

                const color = skuColorMap.get(item.skuId) || 0x999999;
                const mesh = createDraggableProduct(il, iw, ih, color, item.skuName || '未知');
                mesh.position.set(px, py, pz);
                mesh.userData.skuId = item.skuId;
                mesh.userData.dimsCm = { l: item.dims.length, w: item.dims.width, h: item.dims.height };
                mesh.userData.originalDims = item.originalDims || null;
                scene.add(mesh);
                sandboxItemMeshes.push(mesh);
                overflowCount++;
            });
        }

        if (allItems.length === 0 && sandboxItemMeshes.length === 0) {
            showViewerEmpty();
            return;
        }

        for (const item of allItems) {
            const color = skuColorMap.get(item.skuId) || 0x999999;
            const mesh = createDraggableProduct(
                item.length * sandboxScale,
                item.width * sandboxScale,
                item.height * sandboxScale,
                color, item.skuName || '未知'
            );
            mesh.position.set(
                item._posX + (item.length * sandboxScale) / 2,
                item._posY,
                item._posZ + (item.width * sandboxScale) / 2
            );
            mesh.userData.skuId = item.skuId;
            mesh.userData.dimsCm = { l: item.length, w: item.width, h: item.height };
            mesh.userData.originalDims = item.originalDims || null;
            scene.add(mesh);
            sandboxItemMeshes.push(mesh);
        }

        // DragControls（移动模式使用）
        if (typeof THREE.DragControls !== 'undefined') {
            try {
                sandboxDragControls = new THREE.DragControls(sandboxItemMeshes, camera, renderer.domElement);
                sandboxDragControls.addEventListener('dragstart', (event) => {
                    if (controls) controls.enabled = false;
                    if (sandboxSelected) deselectItem();
                    // 保存拖拽前的状态到撤销栈
                    sandboxUndoStack.push(saveSandboxState());
                    if (sandboxUndoStack.length > SANDBOX_MAX_UNDO) sandboxUndoStack.shift();
                    sandboxRedoStack = [];
                    // 记录拖拽起始位置，用于方向模式轴约束
                    if (event && event.object) {
                        sandboxDragStartPos = event.object.position.clone();
                    }
                });
                sandboxDragControls.addEventListener('drag', (event) => {
                    // 方向模式 + 选中了轴 → 轴约束平移
                    if (sandboxAxisMode === 'direction' && sandboxActiveAxis && sandboxDragStartPos) {
                        const pos = event.object.position;
                        const delta = pos.clone().sub(sandboxDragStartPos);
                        const axisVec = new THREE.Vector3(
                            sandboxActiveAxis === 'x' ? 1 : 0,
                            sandboxActiveAxis === 'y' ? 1 : 0,
                            sandboxActiveAxis === 'z' ? 1 : 0
                        );
                        let proj = delta.dot(axisVec);
                        if (sandboxSnapEnabled) {
                            const snapUnit = 0.5 * sandboxScale;
                            proj = Math.round(proj / snapUnit) * snapUnit;
                        }
                        pos.copy(sandboxDragStartPos);
                        pos.x += axisVec.x * proj;
                        pos.y += axisVec.y * proj;
                        pos.z += axisVec.z * proj;
                        // 沿约束轴做边缘吸附
                        if (sandboxSnapEnabled) {
                            snapToItems(event.object, 0.6);
                        }
                    } else if (sandboxSnapEnabled) {
                        // 0.5cm 步长吸附，三轴统一
                        const snapUnit = 0.5 * sandboxScale;
                        event.object.position.x = Math.round(event.object.position.x / snapUnit) * snapUnit;
                        event.object.position.y = Math.round(event.object.position.y / snapUnit) * snapUnit;
                        event.object.position.z = Math.round(event.object.position.z / snapUnit) * snapUnit;
                        // 边缘吸附：靠近其他彩盒或箱壁时自动贴紧
                        snapToItems(event.object, 0.6);
                    }
                    recalcBoundingBox(boxInternal);
                    refreshOverlapState();
                });
                sandboxDragControls.addEventListener('dragend', () => {
                    if (controls) controls.enabled = true;
                    recalcBoundingBox(boxInternal);
                    refreshOverlapState();
                    sandboxDragStartPos = null;
                });
            } catch(e) {}
        }

        // 点击选择：使用 pointer 事件（与 DragControls 的 pointer 事件兼容）（与 DragControls 的 pointer 事件兼容）
        sandbox_mouseDownPos = null;
        renderer.domElement.addEventListener('pointerdown', sandbox_onPointerDown);
        renderer.domElement.addEventListener('pointerup', sandbox_onPointerUp);

        // 工具栏（使用增强版）
        buildEnhancedToolbar(container);

        // 产品面板
        buildProductPanel(container);

        // 相机（使用层架朝向尺寸，与产品布局对齐）
        const sL = boxOrient.length * sandboxScale;
        const sW = boxOrient.width * sandboxScale;
        const sH = boxOrient.height * sandboxScale;
        const dist = Math.max(sL, sW, sH) * 2.5;
        camera.position.set(dist * 0.7, dist * 0.5, dist * 0.7);
        if (controls) {
            controls.target.set(0, sH / 4, 0);
            controls.update();
        }

        // 强制渲染一帧
        if (renderer && scene && camera) renderer.render(scene, camera);

        sandboxMode = 'move';
        sandboxUndoStack = [];
        sandboxRedoStack = [];
        document.addEventListener('keydown', sandbox_onKeyDown);
        recalcBoundingBox(boxInternal);
    };
    ensureViewer(go);
}

function exitSandboxMode() {
    sandboxActive = false;

    document.removeEventListener('keydown', sandbox_onKeyDown);
    sandboxUndoStack = [];
    sandboxRedoStack = [];
    sandboxActiveAxis = null;
    sandboxDragStartPos = null;

    if (sandboxDragControls) {
        sandboxDragControls.dispose();
        sandboxDragControls = null;
    }
    renderer.domElement.removeEventListener('pointerdown', sandbox_onPointerDown);
    renderer.domElement.removeEventListener('pointerup', sandbox_onPointerUp);
    sandboxItemMeshes = [];
    sandboxSelected = null;
    sandboxSelection = [];
    sandboxMode = 'move';
    sandboxOuterBoxDims = null;

    const toolbar = document.getElementById('sandbox-toolbar');
    if (toolbar) toolbar.remove();
    const panel = document.getElementById('sandbox-product-panel');
    if (panel) panel.remove();
    sandboxProductPanel = null;

    showViewerEmpty();
}

function setSandboxMode(mode) {
    if (!sandboxActive || mode === sandboxMode) return;
    sandboxMode = mode;

    // 只保留移动模式
    if (controls) controls.enabled = true;
    if (sandboxDragControls) sandboxDragControls.objects = sandboxItemMeshes;

    updateSandboxToolbar();
}

function createDraggableProduct(pl, pw, ph, color, name) {
    const geo = new THREE.BoxGeometry(pl, ph, pw); // Y-up: (width, height, depth)
    const mat = new THREE.MeshPhongMaterial({
        color, transparent: true, opacity: 0.85,
        emissive: color, emissiveIntensity: 0.08,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;

    const edges = new THREE.EdgesGeometry(geo);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 }));
    line.raycast = () => {}; // 禁止射线检测，防止 DragControls 选中线框而非 Mesh
    mesh.add(line);

    mesh.userData = { name, skuName: name, origColor: color, origEmissive: color };
    return mesh;
}

function recalcBoundingBox(boxInternal) {
    if (!sandboxActive || sandboxItemMeshes.length === 0) return;
    const box3 = new THREE.Box3();
    for (const obj of sandboxItemMeshes) {
        const childBox = new THREE.Box3().setFromObject(obj);
        box3.union(childBox);
    }
    const s = sandboxScale;
    const wCm = (box3.max.x - box3.min.x) / s;
    const dCm = (box3.max.z - box3.min.z) / s;
    const hCm = (box3.max.y - box3.min.y) / s;

    const el = document.getElementById('sandboxDims');
    if (el) {
        el.textContent = `${wCm.toFixed(1)} × ${dCm.toFixed(1)} × ${hCm.toFixed(1)} cm`;
    }
    // 更新件数
    const countEl = document.getElementById('sandboxCount');
    if (countEl) {
        countEl.textContent = `${sandboxItemMeshes.length} 件`;
    }
    // 更新产品面板
    if (sandboxProductPanel) updateProductPanel();
}

/**
 * 边缘吸附：拖拽时靠近其他彩盒或箱壁，自动对齐贴紧（零缝隙零重叠）
 * 每个轴独立计算，找到最近的面对齐位置
 * @param {Object} draggedMesh - 当前拖拽的 Mesh
 * @param {number} thresholdCm - 触发吸附的距离阈值(cm)
 */
function snapToItems(draggedMesh, thresholdCm) {
    if (!sandboxActive || sandboxItemMeshes.length < 2 || !sandboxOuterBoxDims) return;
    const s = sandboxScale;
    const thresh = thresholdCm * s;
    const halfL = sandboxOuterBoxDims.length * s / 2;
    const halfW = sandboxOuterBoxDims.width * s / 2;
    const boxH = sandboxOuterBoxDims.height * s;

    const dBox = new THREE.Box3().setFromObject(draggedMesh);
    const dHalf = new THREE.Vector3(
        (dBox.max.x - dBox.min.x) / 2,
        (dBox.max.y - dBox.min.y) / 2,
        (dBox.max.z - dBox.min.z) / 2
    );

    // 每轴独立跟踪最近的有效对齐位置
    let snapX = null, snapY = null, snapZ = null;
    let bestX = thresh, bestY = thresh, bestZ = thresh;

    // 1) 与其他彩盒的边缘对齐
    for (const other of sandboxItemMeshes) {
        if (other === draggedMesh) continue;
        const oBox = new THREE.Box3().setFromObject(other);

        // X: 我的左面 → 对方的右面 / 我的右面 → 对方的左面
        let d = Math.abs(dBox.min.x - oBox.max.x);
        if (d < bestX) { bestX = d; snapX = oBox.max.x + dHalf.x; }
        d = Math.abs(dBox.max.x - oBox.min.x);
        if (d < bestX) { bestX = d; snapX = oBox.min.x - dHalf.x; }

        // Y: 我的底面 → 对方的顶面 / 我的顶面 → 对方的底面
        d = Math.abs(dBox.min.y - oBox.max.y);
        if (d < bestY) { bestY = d; snapY = oBox.max.y + dHalf.y; }
        d = Math.abs(dBox.max.y - oBox.min.y);
        if (d < bestY) { bestY = d; snapY = oBox.min.y - dHalf.y; }

        // Z: 我的前面 → 对方的后面 / 我的后面 → 对方的前面
        d = Math.abs(dBox.min.z - oBox.max.z);
        if (d < bestZ) { bestZ = d; snapZ = oBox.max.z + dHalf.z; }
        d = Math.abs(dBox.max.z - oBox.min.z);
        if (d < bestZ) { bestZ = d; snapZ = oBox.min.z - dHalf.z; }
    }

    // 2) 与箱壁的对齐
    let d = Math.abs(dBox.min.x - (-halfL));
    if (d < bestX) { bestX = d; snapX = -halfL + dHalf.x; }
    d = Math.abs(dBox.max.x - halfL);
    if (d < bestX) { bestX = d; snapX = halfL - dHalf.x; }

    d = Math.abs(dBox.min.y - 0);
    if (d < bestY) { bestY = d; snapY = dHalf.y; }
    d = Math.abs(dBox.max.y - boxH);
    if (d < bestY) { bestY = d; snapY = boxH - dHalf.y; }

    d = Math.abs(dBox.min.z - (-halfW));
    if (d < bestZ) { bestZ = d; snapZ = -halfW + dHalf.z; }
    d = Math.abs(dBox.max.z - halfW);
    if (d < bestZ) { bestZ = d; snapZ = halfW - dHalf.z; }

    // 应用吸附（每轴独立）
    if (snapX !== null) draggedMesh.position.x = snapX;
    if (snapY !== null) draggedMesh.position.y = snapY;
    if (snapZ !== null) draggedMesh.position.z = snapZ;
}

/**
 * 检测所有沙盘物品之间的碰撞重叠，并将重叠物品标记为红色
 */
function refreshOverlapState() {
    // 已移除红色入侵标识 — 保持产品原始颜色
    return;
}

function sandbox_onPointerDown(e) {
    sandbox_mouseDownPos = { x: e.clientX, y: e.clientY };
}

function sandbox_onPointerUp(e) {
    if (!sandbox_mouseDownPos) return;
    const dx = Math.abs(e.clientX - sandbox_mouseDownPos.x);
    const dy = Math.abs(e.clientY - sandbox_mouseDownPos.y);
    sandbox_mouseDownPos = null;
    if (dx < 5 && dy < 5) onSandboxClick(e);
}

function onSandboxClick(event) {
    if (!sandboxActive || !renderer) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(sandboxItemMeshes, true);
    if (intersects.length > 0) {
        let obj = intersects[0].object;
        while (obj.parent && !sandboxItemMeshes.includes(obj)) obj = obj.parent;
        if (sandboxItemMeshes.includes(obj)) {
            if (event.shiftKey) {
                // 多选模式：切换点击对象的选中状态
                toggleSelection(obj);
            } else {
                // 单选：清除之前选中，选中新对象
                clearSelection();
                sandboxSelected = obj;
                sandboxSelection = [obj];
                applySelectionHighlight();
            }
            updateSandboxToolbar();
            return;
        }
    }

    clearSelection();
    updateSandboxToolbar();
}

function toggleSelection(obj) {
    const idx = sandboxSelection.indexOf(obj);
    if (idx >= 0) {
        // 已在选中中，移除
        sandboxSelection.splice(idx, 1);
        if (obj.material) obj.material.emissiveIntensity = 0.08;
    } else {
        // 加入选中
        sandboxSelection.push(obj);
        if (obj.material) obj.material.emissiveIntensity = 0.6;
    }
    // 更新 sandboxSelected 为最后选中的
    sandboxSelected = sandboxSelection.length > 0 ? sandboxSelection[sandboxSelection.length - 1] : null;
}

function clearSelection() {
    for (const obj of sandboxSelection) {
        if (obj.material) obj.material.emissiveIntensity = 0.08;
    }
    sandboxSelection = [];
    sandboxSelected = null;
    refreshOverlapState();
}

function applySelectionHighlight() {
    for (const obj of sandboxSelection) {
        if (obj.material) obj.material.emissiveIntensity = 0.6;
    }
    for (const obj of sandboxItemMeshes) {
        if (obj.material && !sandboxSelection.includes(obj)) {
            obj.material.emissiveIntensity = 0.08;
        }
    }
    refreshOverlapState();
}

function deselectItem() {
    for (const obj of sandboxSelection) {
        if (obj.material) obj.material.emissiveIntensity = 0.08;
    }
    sandboxSelection = [];
    sandboxSelected = null;
    updateSandboxToolbar();
}

function toggleSnap() {
    sandboxSnapEnabled = !sandboxSnapEnabled;
    const btn = document.getElementById('snapToggle');
    if (btn) btn.textContent = sandboxSnapEnabled ? '吸附: ON' : '吸附: OFF';
}

// ===== 轴模式切换 & 轴按钮 =====

function setSandboxAxisMode(mode) {
    if (!sandboxActive) return;
    sandboxAxisMode = mode;
    sandboxActiveAxis = null; // 切换模式时清除已选中的轴
    updateSandboxToolbar();
}

function onAxisButtonClick(axis) {
    if (!sandboxActive) return;

    // 点击已激活的轴 → 取消选中
    if (sandboxActiveAxis === axis) {
        sandboxActiveAxis = null;
        updateSandboxToolbar();
        return;
    }

    sandboxActiveAxis = axis;

    // 旋转模式下，选中轴后立即旋转已选中的彩盒
    if (sandboxAxisMode === 'rotate' && sandboxSelected) {
        rotateSandboxItem(axis, 1);
    }

    updateSandboxToolbar();
}

// ===== 90° 旋转 & Undo/Redo =====

function saveSandboxState() {
    return sandboxItemMeshes.map(m => ({
        id: m.id,
        quaternion: m.quaternion.clone(),
        position: m.position.clone(),
    }));
}

function restoreSandboxState(state) {
    for (const s of state) {
        const mesh = sandboxItemMeshes.find(m => m.id === s.id);
        if (mesh) {
            mesh.quaternion.copy(s.quaternion);
            mesh.position.copy(s.position);
        }
    }
    recalcBoundingBox(sandboxOuterBoxDims);
    refreshOverlapState();
    if (sandboxProductPanel) updateProductPanel();
}

function rotateSandboxItem(axis, sign) {
    if (!sandboxSelected || !sandboxActive) return;

    // 保存撤销状态
    sandboxUndoStack.push(saveSandboxState());
    if (sandboxUndoStack.length > SANDBOX_MAX_UNDO) sandboxUndoStack.shift();
    sandboxRedoStack = [];

    // 绕指定轴 90° 旋转（局部空间）
    const axisVec = new THREE.Vector3(
        axis === 'x' ? 1 : 0,
        axis === 'y' ? 1 : 0,
        axis === 'z' ? 1 : 0
    );
    const quat = new THREE.Quaternion().setFromAxisAngle(axisVec, Math.PI / 2 * sign);
    sandboxSelected.quaternion.multiply(quat);

    recalcBoundingBox(sandboxOuterBoxDims);
    refreshOverlapState();
    if (sandboxProductPanel) updateProductPanel();
    updateSandboxToolbar();
}

function sandboxUndo() {
    if (!sandboxActive || sandboxUndoStack.length === 0) return;
    sandboxRedoStack.push(saveSandboxState());
    if (sandboxRedoStack.length > SANDBOX_MAX_UNDO) sandboxRedoStack.shift();
    restoreSandboxState(sandboxUndoStack.pop());
    updateSandboxToolbar();
}

function sandboxRedo() {
    if (!sandboxActive || sandboxRedoStack.length === 0) return;
    sandboxUndoStack.push(saveSandboxState());
    if (sandboxUndoStack.length > SANDBOX_MAX_UNDO) sandboxUndoStack.shift();
    restoreSandboxState(sandboxRedoStack.pop());
    updateSandboxToolbar();
}

function sandbox_onKeyDown(e) {
    if (!sandboxActive) return;
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        sandboxUndo();
    } else if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        sandboxRedo();
    }
}

function buildEnhancedToolbar(container) {
    const existing = document.getElementById('sandbox-toolbar');
    if (existing) existing.remove();

    const toolbar = document.createElement('div');
    toolbar.id = 'sandbox-toolbar';
    toolbar.innerHTML = `
        <div class="sandbox-toolbar-row">
            <span style="font-weight:600;font-size:13px;color:#1a73e8;">🖐 沙盘模式</span>
            <button class="sandbox-axis-mode-btn sandbox-axis-mode-active" data-axismode="direction" onclick="window.setSandboxAxisMode('direction')">方向</button>
            <button class="sandbox-axis-mode-btn" data-axismode="rotate" onclick="window.setSandboxAxisMode('rotate')">旋转</button>
            <span class="toolbar-separator"></span>
            <button class="sandbox-axis-btn" data-axis="x" onclick="window.onAxisButtonClick('x')">X 轴</button>
            <button class="sandbox-axis-btn" data-axis="y" onclick="window.onAxisButtonClick('y')">Y 轴</button>
            <button class="sandbox-axis-btn" data-axis="z" onclick="window.onAxisButtonClick('z')">Z 轴</button>
            <span class="toolbar-separator"></span>
            <button class="btn btn-sm btn-outline" onclick="window.toggleSnap()" id="snapToggle">吸附: ON</button>
            <button class="btn btn-sm btn-outline" onclick="window.sandboxUndo()" id="undoBtn" title="撤销 Ctrl+Z">↩ 撤销</button>
            <button class="btn btn-sm btn-outline" onclick="window.sandboxRedo()" id="redoBtn" title="重做 Ctrl+Y">↪ 重做</button>
            <button class="btn btn-sm btn-danger" onclick="window.exitSandboxMode()" style="margin-left:auto;">退出沙盘</button>
        </div>
        <div class="sandbox-toolbar-row" style="font-size:13px;color:#666;gap:16px;">
            <span>外尺寸: <strong id="sandboxDims" style="color:#1a73e8;font-family:monospace;">—</strong></span>
            <span>件数: <strong id="sandboxCount" style="color:#1a73e8;">0</strong></span>
            <span>选中: <strong id="sandboxSelectedCount" style="color:#e37400;">0</strong></span>
            <span id="sandboxSelectedName" style="color:#888;">未选中</span>
        </div>
    `;
    container.prepend(toolbar);
}

function buildProductPanel(container) {
    const existing = document.getElementById('sandbox-product-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'sandbox-product-panel';
    panel.innerHTML = `
        <div class="panel-header">产品清单</div>
        <div class="panel-list" id="panelList"></div>
        <div class="panel-footer">
            <div class="panel-total-dims" id="panelTotalDims">外尺寸: —</div>
            <div class="panel-total-count" id="panelTotalCount">总件数: 0</div>
            <div style="margin-top:8px;padding-top:8px;border-top:1px solid #e8edf5;">
                <div style="font-size:12px;color:#666;font-weight:500;margin-bottom:4px;">箱内剩余</div>
                <div style="font-size:12px;color:#1a73e8;font-family:monospace;" id="panelRemaining">
                    长: —&nbsp;&nbsp;宽: —&nbsp;&nbsp;高: —
                </div>
            </div>
        </div>
    `;
    container.appendChild(panel);
    sandboxProductPanel = panel;
    updateProductPanel();
}

function updateProductPanel() {
    const list = document.getElementById('panelList');
    if (!list || !sandboxActive) return;

    if (sandboxItemMeshes.length === 0) {
        list.innerHTML = '<div class="panel-empty">无产品</div>';
        return;
    }

    // 按 SKU 分组
    const groups = {};
    for (const mesh of sandboxItemMeshes) {
        const name = mesh.userData.skuName || '未知';
        if (!groups[name]) groups[name] = [];
        groups[name].push(mesh);
    }

    let html = '';
    for (const [name, meshes] of Object.entries(groups)) {
        const mesh = meshes[0];
        const color = mesh.material ? mesh.material.color.getHex() : 0x999999;
        const colorStr = '#' + color.toString(16).padStart(6, '0');
        const dims = mesh.userData.originalDims || mesh.userData.dimsCm || {};
        const dimsStr = dims.length != null ? `${dims.length}×${dims.width}×${dims.height} cm` :
                        dims.l != null ? `${dims.l}×${dims.w}×${dims.h} cm` : '';
        html += `
            <div class="panel-item">
                <span class="panel-swatch" style="background:${colorStr};"></span>
                <span class="panel-label">${name}</span>
                <span class="panel-dims">${dimsStr}</span>
                <span class="panel-qty">×${meshes.length}</span>
            </div>
        `;
    }

    list.innerHTML = html;

    // 更新底部汇总
    const box3 = new THREE.Box3();
    for (const obj of sandboxItemMeshes) {
        const childBox = new THREE.Box3().setFromObject(obj);
        box3.union(childBox);
    }
    const s = sandboxScale;
    const wCm = (box3.max.x - box3.min.x) / s;
    const dCm = (box3.max.z - box3.min.z) / s;
    const hCm = (box3.max.y - box3.min.y) / s;

    const totalDims = document.getElementById('panelTotalDims');
    if (totalDims) {
        totalDims.textContent = `外尺寸: ${wCm.toFixed(1)} × ${dCm.toFixed(1)} × ${hCm.toFixed(1)} cm`;
    }
    const totalCount = document.getElementById('panelTotalCount');
    if (totalCount) {
        totalCount.textContent = `总件数: ${sandboxItemMeshes.length}`;
    }

    // 箱内剩余
    if (sandboxOuterBoxDims) {
        const remL = Math.max(0, sandboxOuterBoxDims.length - wCm);
        const remW = Math.max(0, sandboxOuterBoxDims.width - dCm);
        const remH = Math.max(0, sandboxOuterBoxDims.height - hCm);
        const remEl = document.getElementById('panelRemaining');
        if (remEl) {
            remEl.innerHTML = `长: ${remL.toFixed(1)} cm&nbsp;&nbsp;宽: ${remW.toFixed(1)} cm&nbsp;&nbsp;高: ${remH.toFixed(1)} cm`;
        }
    }
}

function updateSandboxToolbar() {
    // 更新轴模式按钮（方向 / 旋转）
    const axisModeBtns = document.querySelectorAll('.sandbox-axis-mode-btn');
    for (const btn of axisModeBtns) {
        const mode = btn.getAttribute('data-axismode');
        btn.classList.toggle('sandbox-axis-mode-active', mode === sandboxAxisMode);
    }
    // 更新 X/Y/Z 轴按钮状态
    const axisBtns = document.querySelectorAll('.sandbox-axis-btn');
    for (const btn of axisBtns) {
        const axis = btn.getAttribute('data-axis');
        const isActive = sandboxActiveAxis === axis;
        btn.classList.toggle('sandbox-axis-active', isActive);
        // 根据当前模式设置不同的激活颜色
        if (isActive) {
            btn.classList.toggle('axis-mode-direction', sandboxAxisMode === 'direction');
            btn.classList.toggle('axis-mode-rotate', sandboxAxisMode === 'rotate');
        }
    }
    // 更新选中信息
    const nameEl = document.getElementById('sandboxSelectedName');
    if (nameEl) {
        nameEl.textContent = sandboxSelected ? (sandboxSelected.userData.skuName || '已选中') : '未选中';
    }
    const countEl = document.getElementById('sandboxSelectedCount');
    if (countEl) countEl.textContent = sandboxSelection.length;
}

// ===== 空腔可视化 =====

let cavityGroup = null;
let cavityVisible = false;

/**
 * 在场景中绘制空腔（半透明线框）
 * @param {Array} cavities - [{x, y, z, l, w, h}]
 * @param {number} scale - 场景缩放比
 * @param {Object} boxOrient - {length, width, height} 箱子朝向
 */
function drawCavities(cavities, scale, boxOrient) {
    if (!scene) return;

    // 移除旧空腔组
    if (cavityGroup) {
        scene.remove(cavityGroup);
        disposeGroup(cavityGroup);
        cavityGroup = null;
    }

    if (!cavities || cavities.length === 0) return;

    cavityGroup = new THREE.Group();
    cavityGroup.visible = cavityVisible;

    const fL = boxOrient.length * scale;
    const fW = boxOrient.width * scale;

    for (const cav of cavities) {
        if (cav.l < 0.5 || cav.w < 0.5 || cav.h < 0.5) continue;
        const cL = cav.l * scale;
        const cW = cav.w * scale;
        const cH = cav.h * scale;
        const cx = cav.x * scale - fL / 2 + cL / 2;
        const cy = cav.z * scale + cH / 2;
        const cz = cav.y * scale - fW / 2 + cW / 2;

        // 半透明填充
        const geo = new THREE.BoxGeometry(cL, cH, cW);
        const mat = new THREE.MeshPhongMaterial({
            color: 0x34a853,
            transparent: true,
            opacity: 0.08,
            depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(cx, cy, cz);
        cavityGroup.add(mesh);

        // 虚线线框
        const edges = new THREE.EdgesGeometry(geo);
        const lineMat = new THREE.LineBasicMaterial({
            color: 0x34a853,
            transparent: true,
            opacity: 0.3,
        });
        const line = new THREE.LineSegments(edges, lineMat);
        line.position.copy(mesh.position);
        cavityGroup.add(line);
    }

    scene.add(cavityGroup);
}

function disposeGroup(group) {
    while (group.children.length) {
        const child = group.children[0];
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
        group.remove(child);
    }
}

function clearCavities() {
    if (cavityGroup && scene) {
        scene.remove(cavityGroup);
        disposeGroup(cavityGroup);
        cavityGroup = null;
    }
}

function toggleCavityVisibility() {
    cavityVisible = !cavityVisible;
    if (cavityGroup) {
        cavityGroup.visible = cavityVisible;
    }
    return cavityVisible;
}

function isCavityVisible() {
    return cavityVisible;
}

// 导出
window.loadGroupIntoViewer = loadGroupIntoViewer;
window.showViewerEmpty = showViewerEmpty;
window.enterSandboxMode = enterSandboxMode;
window.exitSandboxMode = exitSandboxMode;
window.toggleSnap = toggleSnap;
window.setSandboxMode = setSandboxMode;
window.drawCavities = drawCavities;
window.clearCavities = clearCavities;
window.toggleCavityVisibility = toggleCavityVisibility;
window.isCavityVisible = isCavityVisible;
window.rotateSandboxItem = rotateSandboxItem;
window.sandboxUndo = sandboxUndo;
window.sandboxRedo = sandboxRedo;
window.setSandboxAxisMode = setSandboxAxisMode;
window.onAxisButtonClick = onAxisButtonClick;
