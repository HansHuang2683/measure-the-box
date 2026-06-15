// ===== Replenishment recommendation =====
// Fixed-base packing: keep the current layout, then recommend extra small items.

const REPLENISHMENT_CONFIG = {
    minCavitySide: 0.5,
    minCavityVolume: 1,
    maxTotalItemsPerBox: 160,
    maxPerSkuPerBox: 60,
    defaultReorderPerBoxCap: 30,
    smallHardBoxVolumeRatio: 0.08,
    hardSupportRatio: 0.85,
    softSupportRatio: 0.5,
    aggressiveSoftSideScale: 0.82,
    theoreticalVisualMinSideScale: 0.38,
    theoreticalOverlapRatio: 0.42,
    boxSizeStep: 5,
    minBoxSide: 30,
    boxAlternativeLimit: 8,
    targetUtilization: 0.98,
    theoreticalFillCap: 1.0,
};

function buildReplenishmentCandidates(skus, mixedGroups, group, boxType, options) {
    options = options || {};
    const candidates = [];
    const allocated = {};

    for (const g of mixedGroups || []) {
        for (const a of g.assignments || []) {
            allocated[a.skuId] = (allocated[a.skuId] || 0) + (a.qtyPerBox || 0) * (g.boxCount || 0);
        }
    }

    const boxVol = boxType && boxType.internal ? dimsVolume(boxType.internal) : 0;
    const groupSkuIds = new Set((group.assignments || []).map(a => a.skuId));

    for (const sku of skus || []) {
        if (!sku || !sku.dimensions) continue;
        const effective = getEffectiveDimensions(sku);
        const vol = dimsVolume(effective);
        const remaining = Math.max(0, (sku.quantity || 0) - (allocated[sku.id] || 0));
        const isSoft = sku.packagingType === 'soft';
        const isSmallHard = !isSoft && boxVol > 0 && vol / boxVol <= REPLENISHMENT_CONFIG.smallHardBoxVolumeRatio;

        // Default candidate pool: soft packs, unallocated SKUs, and small hard boxes.
        if (!isSoft && !isSmallHard && remaining <= 0) continue;

        const reorderCap = Math.max(
            group.boxCount || CONFIG.defaultMinBoxes,
            (group.boxCount || CONFIG.defaultMinBoxes) * REPLENISHMENT_CONFIG.defaultReorderPerBoxCap
        );

        candidates.push({
            id: 'repl_' + sku.id,
            skuId: sku.id,
            name: sku.name,
            dimensions: dimsClone(sku.dimensions),
            packagingType: sku.packagingType || 'hard',
            softTolerance: sku.softTolerance || 0,
            maxQty: Math.max(remaining, reorderCap),
            priority: isSoft ? 3 : 2,
            allowStackOnHard: isSoft,
            source: remaining > 0 ? '未分配SKU' : (groupSkuIds.has(sku.id) ? '同款补货' : '现有SKU补货'),
        });
    }

    return candidates;
}

function generateReplenishmentPlan(group, boxType, skus, candidates, options) {
    options = options || {};
    const boxInternal = boxType.internal;
    const baseResult = options.baseResult || (
        typeof generateMixedLayoutCavity === 'function'
            ? generateMixedLayoutCavity(group, skus, boxInternal)
            : generateMixedLayout(group, skus, boxInternal)
    );

    const layers = baseResult.layers || [];
    const boxOrient = (layers[0] && layers[0].boxOrientation) || boxInternal;
    const boxVol = dimsVolume(boxOrient);
    const basePlaced = _replExtractPlacedItems(layers);
    const basePhysicalVolume = baseResult.productVolume || _replVolumeFromPlacedItems(basePlaced, false);
    const baseTheoreticalVolume = _replVolumeFromPlacedItems(basePlaced, true);

    let cavities = _replBuildCavities(basePlaced, boxOrient);
    const cavitiesBefore = cavities.map(_replCloneCavity);
    const targetUtilization = options.targetUtilization || REPLENISHMENT_CONFIG.targetUtilization;
    const simulation = simulateReplenishmentPlacements(basePlaced, candidates, cavities, boxOrient, {
        boxCount: group.boxCount,
        maxTotalItemsPerBox: options.maxTotalItemsPerBox || REPLENISHMENT_CONFIG.maxTotalItemsPerBox,
        maxPerSkuPerBox: options.maxPerSkuPerBox || REPLENISHMENT_CONFIG.maxPerSkuPerBox,
        aggressiveSoftPacking: options.aggressiveSoftPacking !== false,
        maxAddedVolume: Math.max(0, boxVol * targetUtilization - basePhysicalVolume),
    });

    const physicalAdditions = _replSummarizeAdditions(simulation.placements, candidates, group.boxCount || 1, boxVol);
    const physicalAddedVolume = simulation.placements.reduce((s, p) => s + p.length * p.width * p.height, 0);
    const currentPhysicalUtilization = boxVol > 0 ? basePhysicalVolume / boxVol : 0;
    const projectedPhysicalUtilization = boxVol > 0 ? (basePhysicalVolume + physicalAddedVolume) / boxVol : currentPhysicalUtilization;

    const theoreticalPlan = _replBuildTheoreticalSoftPlan({
        group,
        candidates,
        boxOrient,
        boxVol,
        boxCount: group.boxCount || 1,
        basePlaced,
        cavitiesBefore,
        basePhysicalVolume,
        baseTheoreticalVolume,
        options,
    });
    const currentTheoreticalUtilization = boxVol > 0 ? baseTheoreticalVolume / boxVol : 0;
    const projectedTheoreticalUtilization = boxVol > 0
        ? (baseTheoreticalVolume + theoreticalPlan.addedOriginalVolume) / boxVol
        : currentTheoreticalUtilization;

    return {
        groupId: group.id,
        boxTypeId: boxType.id,
        boxCount: group.boxCount || 1,
        fitMode: 'dual',
        currentPhysicalUtilization,
        projectedPhysicalUtilization,
        currentTheoreticalUtilization,
        projectedTheoreticalUtilization,
        currentUtilization: currentPhysicalUtilization,
        projectedUtilization: projectedPhysicalUtilization,
        physicalAddedVolume,
        theoreticalAddedVolume: theoreticalPlan.addedPhysicalVolume,
        theoreticalOriginalAddedVolume: theoreticalPlan.addedOriginalVolume,
        additions: physicalAdditions,
        physicalAdditions,
        theoreticalAdditions: theoreticalPlan.additions,
        cavitiesBefore,
        cavitiesAfter: simulation.cavities.map(_replCloneCavity),
        unusableReasons: summarizeUnusableCavities(simulation.cavities, candidates),
        overlayPlacements: simulation.placements,
        physicalPlacements: simulation.placements,
        realPlacements: basePlaced,
        compressedPlacements: theoreticalPlan.compressedPlacements,
        boxOrientation: boxOrient,
        baseResult,
        aggressiveSoftPacking: options.aggressiveSoftPacking !== false,
        targetUtilization,
        theoreticalTargetUtilization: REPLENISHMENT_CONFIG.theoreticalFillCap,
        theoreticalModeNote: theoreticalPlan.additions.length > 0
            ? '软包理论压缩按原始体积估算，利用率可超过100%'
            : '当前候选中没有可用于理论压缩的软包',
    };
}

function generateBoxReplenishmentAlternatives(group, currentBoxType, skus, candidates, options) {
    options = options || {};
    const boxCandidates = _replGetListedBoxCandidates(currentBoxType, options);
    const alternatives = [];

    for (const tempBox of boxCandidates) {
        const external = tempBox.external;
        const internal = tempBox.internal;

        let baseResult;
        try {
            baseResult = typeof generateMixedLayoutCavity === 'function'
                ? generateMixedLayoutCavity(group, skus, internal)
                : generateMixedLayout(group, skus, internal);
        } catch (e) {
            continue;
        }
        if (!baseResult ||
            baseResult.impossible ||
            !baseResult.verifiedFit ||
            (baseResult.overflowItems && baseResult.overflowItems.length > 0) ||
            !baseResult.layers ||
            baseResult.layers.length === 0) {
            continue;
        }

        const plan = generateReplenishmentPlan(group, tempBox, skus, candidates, {
            ...options,
            baseResult,
            aggressiveSoftPacking: options.aggressiveSoftPacking !== false,
        });
        const physicalAddedQty = (plan.physicalAdditions || []).reduce((s, a) => s + a.qtyPerBox, 0);
        const theoreticalAddedQty = (plan.theoreticalAdditions || []).reduce((s, a) => s + a.qtyPerBox, 0);
        const externalVol = dimsVolume(external);
        const currentExternalVol = currentBoxType.external ? dimsVolume(currentBoxType.external) : Infinity;

        alternatives.push({
            boxType: tempBox,
            plan,
            physicalAddedQtyPerBox: physicalAddedQty,
            theoreticalAddedQtyPerBox: theoreticalAddedQty,
            addedQtyPerBox: theoreticalAddedQty || physicalAddedQty,
            externalVolume: externalVol,
            volumeDelta: Number.isFinite(currentExternalVol) ? externalVol / currentExternalVol - 1 : 0,
            score: plan.projectedTheoreticalUtilization * 1000 +
                plan.projectedPhysicalUtilization * 100 +
                (theoreticalAddedQty || physicalAddedQty) * 8 -
                (externalVol / 100000),
        });
    }

    alternatives.sort((a, b) =>
        b.plan.projectedTheoreticalUtilization - a.plan.projectedTheoreticalUtilization ||
        b.plan.projectedPhysicalUtilization - a.plan.projectedPhysicalUtilization ||
        a.externalVolume - b.externalVolume ||
        b.addedQtyPerBox - a.addedQtyPerBox
    );
    return alternatives.slice(0, options.limit || REPLENISHMENT_CONFIG.boxAlternativeLimit);
}

function simulateReplenishmentPlacements(basePlaced, candidates, cavities, boxInternal, options) {
    options = options || {};
    let placedItems = basePlaced.map(_replClonePlaced);
    let currentCavities = cavities.map(_replCloneCavity);
    const placements = [];
    const perSkuCounts = {};
    const maxTotal = options.maxTotalItemsPerBox || REPLENISHMENT_CONFIG.maxTotalItemsPerBox;
    const boxCount = options.boxCount || 1;
    const maxAddedVolume = options.maxAddedVolume == null ? Infinity : options.maxAddedVolume;
    let addedVolume = 0;

    const normalized = (candidates || []).map(c => _replNormalizeCandidate(c, boxCount, options))
        .filter(c => c.maxPerBox > 0 && c.dims.length > 0 && c.dims.width > 0 && c.dims.height > 0);

    for (let step = 0; step < maxTotal; step++) {
        let best = null;
        for (const candidate of normalized) {
            const count = perSkuCounts[candidate.id] || 0;
            const maxPerBox = Math.min(candidate.maxPerBox, options.maxPerSkuPerBox || REPLENISHMENT_CONFIG.maxPerSkuPerBox);
            if (count >= maxPerBox) continue;

            const fits = enumerateCandidateFits(candidate, currentCavities, placedItems, boxInternal);
            for (const fit of fits) {
                const fitVol = fit.orientation.l * fit.orientation.w * fit.orientation.h;
                if (addedVolume + fitVol > maxAddedVolume + 0.01) continue;
                if (!best || fit.score > best.score) best = fit;
            }
        }

        if (!best) break;

        const p = {
            skuId: best.candidate.skuId || best.candidate.id,
            skuName: best.candidate.name,
            candidateId: best.candidate.id,
            x: best.cavity.x,
            y: best.cavity.y,
            z: best.cavity.z,
            length: best.orientation.l,
            width: best.orientation.w,
            height: best.orientation.h,
            originalDims: best.candidate.dimensions,
            packagingType: best.candidate.packagingType,
            virtual: true,
            source: best.cavity.source || 'cavity',
            supportRatio: best.supportRatio,
        };
        placements.push(p);
        addedVolume += p.length * p.width * p.height;
        perSkuCounts[best.candidate.id] = (perSkuCounts[best.candidate.id] || 0) + 1;

        placedItems.push({
            x: p.x, y: p.y, z: p.z,
            l: p.length, w: p.width, h: p.height,
            skuId: p.skuId, skuName: p.skuName,
            packagingType: p.packagingType,
        });

        currentCavities = subtractFromCavities(currentCavities, p.x, p.y, p.z, p.length, p.width, p.height,
            boxInternal.length, boxInternal.width, boxInternal.height);
        currentCavities = _replFilterCavities(currentCavities);
        currentCavities.sort(_replCavitySort);
    }

    return { placements, cavities: currentCavities, perSkuCounts };
}

function enumerateCandidateFits(candidate, cavities, placedItems, boxInternal) {
    const fits = [];
    for (const cavity of cavities || []) {
        if (!_replCavityUsable(cavity)) continue;
        const orients = _replOrientations(candidate.dims, cavity.l, cavity.w, cavity.h);
        for (const orient of orients) {
            if (cavity.z + orient.h > boxInternal.height + 0.01) continue;
            if (!_replWithinBox(cavity.x, cavity.y, cavity.z, orient, boxInternal)) continue;
            if (_replOverlapsExisting(cavity.x, cavity.y, cavity.z, orient, placedItems)) continue;

            const supportRatio = _replSupportRatio(cavity.x, cavity.y, cavity.z, orient.l, orient.w, placedItems);
            const requiredSupport = candidate.packagingType === 'soft'
                ? REPLENISHMENT_CONFIG.softSupportRatio
                : REPLENISHMENT_CONFIG.hardSupportRatio;
            if (supportRatio < requiredSupport) continue;

            fits.push({
                candidate,
                cavity,
                orientation: orient,
                supportRatio,
                score: scoreReplenishmentFit(candidate, cavity, orient, supportRatio, boxInternal),
            });
        }
    }
    return fits;
}

function scoreReplenishmentFit(candidate, cavity, orient, supportRatio, boxInternal) {
    const itemVol = orient.l * orient.w * orient.h;
    const cavityVol = cavity.l * cavity.w * cavity.h;
    const boxVol = dimsVolume(boxInternal);
    const fillRatio = cavityVol > 0 ? itemVol / cavityVol : 0;
    const lowScore = boxInternal.height > 0 ? (1 - cavity.z / boxInternal.height) : 0;
    const sideTouch = (cavity.x < 0.01 || cavity.y < 0.01 ||
        Math.abs(cavity.x + orient.l - boxInternal.length) < 0.01 ||
        Math.abs(cavity.y + orient.w - boxInternal.width) < 0.01) ? 1 : 0;

    let score = 0;
    score += (boxVol > 0 ? itemVol / boxVol : 0) * 100000;
    score += Math.min(fillRatio, 1) * 450;
    score += lowScore * 250;
    score += (candidate.priority || 1) * 80;
    score += supportRatio * 120;
    score += sideTouch * 40;
    score -= _replFragmentPenalty(cavity, orient) * 35;
    if (candidate.packagingType !== 'soft' && cavity.z > 0.01) score -= 120;
    return score;
}

function summarizeUnusableCavities(cavities, candidates) {
    const reasons = [];
    const usable = (cavities || []).filter(_replCavityUsable);
    if (usable.length === 0) {
        reasons.push('剩余空腔过小或已被推荐件占用');
        return reasons;
    }
    const minCandidateSide = _replMinCandidateSide(candidates);
    const narrow = usable.filter(c => Math.min(c.l, c.w, c.h) < minCandidateSide);
    if (narrow.length > 0) reasons.push(narrow.length + ' 个空腔存在窄边，小于候选产品最小边');
    const top = usable.filter(c => c.z > 0.01);
    if (top.length > 0) {
        const hasSoftCandidate = (candidates || []).some(c => c.packagingType === 'soft');
        reasons.push(hasSoftCandidate
            ? top.length + ' 个上层/平台空腔仍未匹配到合适候选（多为窄条、碎片或支撑不足）'
            : top.length + ' 个上层空腔需要支撑，硬包装不建议放入');
    }
    const totalVol = usable.reduce((s, c) => s + c.l * c.w * c.h, 0);
    if (totalVol > 0) reasons.push('剩余碎片空腔总体积约 ' + totalVol.toFixed(0) + ' cm³');
    return reasons;
}

function _replBuildTheoreticalSoftPlan(ctx) {
    const {
        candidates,
        boxOrient,
        boxVol,
        boxCount,
        cavitiesBefore,
        basePhysicalVolume,
        baseTheoreticalVolume,
        options,
    } = ctx;

    const softCandidates = (candidates || [])
        .filter(c => c && c.packagingType === 'soft')
        .map(c => {
            const dimsEff = _replSoftEffectiveDims(c, options.theoreticalAggressiveSoftPacking !== false);
            const physicalVolume = dimsVolume(dimsEff);
            const originalVolume = dimsVolume(c.dimensions || dimsEff);
            const ratio = physicalVolume > 0 ? originalVolume / physicalVolume : 0;
            const maxPerBox = Math.max(0, Math.floor((c.maxQty || 0) / Math.max(1, boxCount || 1)));
            return {
                ...c,
                dims: dimsEff,
                physicalVolume,
                originalVolume,
                ratio,
                maxPerBox,
            };
        })
        .filter(c => c.maxPerBox > 0 && c.dims.length > 0 && c.dims.width > 0 && c.dims.height > 0);

    const cavityCapacity = (cavitiesBefore || [])
        .filter(_replCavityUsable)
        .reduce((sum, c) => sum + c.l * c.w * c.h, 0);
    const geometricCapacity = Math.max(0, boxVol * (options.theoreticalFillCap || REPLENISHMENT_CONFIG.theoreticalFillCap) - basePhysicalVolume);
    const remainingCapacity = Math.max(0, Math.max(cavityCapacity, geometricCapacity));
    const perSkuCounts = {};
    const maxTotal = options.maxTotalItemsPerBox || REPLENISHMENT_CONFIG.maxTotalItemsPerBox;
    const maxPerSku = options.maxPerSkuPerBox || REPLENISHMENT_CONFIG.maxPerSkuPerBox;
    let remaining = remainingCapacity;

    for (let step = 0; step < maxTotal; step++) {
        let best = null;
        for (const candidate of softCandidates) {
            const count = perSkuCounts[candidate.id] || 0;
            const perBoxCap = Math.min(candidate.maxPerBox, maxPerSku);
            if (count >= perBoxCap) continue;
            if (candidate.physicalVolume > remaining + 0.0001) continue;

            const score = (candidate.ratio * 1000) +
                ((candidate.priority || 1) * 80) +
                (candidate.originalVolume / 1000) -
                (candidate.physicalVolume / 2000);
            if (!best || score > best.score) {
                best = { candidate, score };
            }
        }
        if (!best) break;
        perSkuCounts[best.candidate.id] = (perSkuCounts[best.candidate.id] || 0) + 1;
        remaining -= best.candidate.physicalVolume;
    }

    const selections = [];
    for (const candidate of softCandidates) {
        const qty = perSkuCounts[candidate.id] || 0;
        if (qty <= 0) continue;
        selections.push({
            candidate,
            qty,
            physicalVolume: candidate.physicalVolume * qty,
            originalVolume: candidate.originalVolume * qty,
        });
    }

    selections.sort((a, b) =>
        b.originalVolume - a.originalVolume ||
        b.physicalVolume - a.physicalVolume ||
        (b.candidate.priority || 1) - (a.candidate.priority || 1)
    );

    const compressedPlacements = _replBuildTheoreticalCompressedPlacements(selections, boxOrient, cavitiesBefore, options);
    const placementMap = {};
    for (const p of compressedPlacements) {
        if (!placementMap[p.candidateId]) placementMap[p.candidateId] = [];
        placementMap[p.candidateId].push(p);
    }

    const additions = selections.map(sel => {
        const candidate = sel.candidate;
        return {
            candidateId: candidate.id,
            name: candidate.name,
            packagingType: candidate.packagingType,
            qtyPerBox: sel.qty,
            totalQty: sel.qty * boxCount,
            volumeContribution: boxVol > 0 ? sel.originalVolume / boxVol : 0,
            compressedVolumeContribution: boxVol > 0 ? sel.physicalVolume / boxVol : 0,
            placements: placementMap[candidate.id] || [],
            placementSummary: '软包逐件压缩填空',
            warnings: ['软包按压缩率允许局部重叠，3D 用于展示采购补货方向'],
        };
    });

    return {
        additions,
        compressedPlacements,
        addedPhysicalVolume: selections.reduce((s, sel) => s + sel.physicalVolume, 0),
        addedOriginalVolume: selections.reduce((s, sel) => s + sel.originalVolume, 0),
    };
}

function _replBuildTheoreticalCompressedPlacements(selections, boxOrient, cavities, options) {
    options = options || {};
    const placements = [];
    const usableCavities = (cavities || [])
        .filter(_replCavityUsable)
        .map((c, idx) => ({
            ..._replCloneCavity(c),
            idx,
            volume: c.l * c.w * c.h,
            remainingVolume: c.l * c.w * c.h,
            itemCount: 0,
        }))
        .sort((a, b) => {
            if (options.preferTopCavities) {
                return b.z - a.z || b.volume - a.volume;
            }
            return a.z - b.z || b.volume - a.volume;
        });
    if (usableCavities.length === 0) return placements;

    const units = [];
    let colorIdx = 0;
    for (const sel of selections || []) {
        const candidate = sel.candidate;
        const color = _replSoftPreviewColor(colorIdx++);
        for (let i = 0; i < sel.qty; i++) {
            units.push({
                skuId: candidate.skuId || candidate.id,
                candidateId: candidate.id,
                skuName: candidate.name,
                packagingType: candidate.packagingType,
                originalDims: candidate.dimensions,
                effectiveDims: candidate.dims,
                qtyPerBox: 1,
                totalQty: sel.qty,
                unitIndex: i + 1,
                theoretical: true,
                virtual: true,
                physicalVolume: candidate.physicalVolume,
                originalVolume: candidate.originalVolume,
                priority: candidate.priority || 1,
                colorHex: color,
            });
        }
    }

    units.sort((a, b) =>
        b.priority - a.priority ||
        b.originalVolume - a.originalVolume ||
        b.physicalVolume - a.physicalVolume
    );

    for (const unit of units) {
        const cavity = _replPickTheoreticalCavity(usableCavities, unit.physicalVolume, options, boxOrient);
        if (!cavity) break;
        const placement = _replPlaceCompressedUnit(unit, cavity, boxOrient, options);
        placements.push(placement);
        cavity.remainingVolume -= unit.physicalVolume;
        cavity.itemCount += 1;
    }

    return placements;
}

function _replPickTheoreticalCavity(cavities, unitVolume, options, boxOrient) {
    options = options || {};
    let best = null;
    for (const c of cavities || []) {
        const canAbsorb = c.remainingVolume + 0.01 >= unitVolume;
        const sideTouch = boxOrient ? (
            c.x < 0.01 ||
            c.y < 0.01 ||
            Math.abs(c.x + c.l - boxOrient.length) < 0.01 ||
            Math.abs(c.y + c.w - boxOrient.width) < 0.01
        ) : false;
        const topRatio = boxOrient && boxOrient.height > 0 ? c.z / boxOrient.height : 0;
        const shallowTopBonus = options.preferTopCavities && boxOrient
            ? topRatio * 200000 + (sideTouch ? 30000 : 0) - Math.max(0, c.h - 6) * 1200
            : 0;
        const score = (canAbsorb ? 100000 : 0) +
            shallowTopBonus +
            c.remainingVolume -
            (options.preferTopCavities ? 0 : c.z * 50) +
            c.volume * 0.01;
        if (!best || score > best.score) best = { cavity: c, score };
    }
    if (!best) return null;
    best.cavity.forceVolumeEstimate = best.cavity.remainingVolume + 0.01 < unitVolume;
    return best.cavity;
}

function _replPlaceCompressedUnit(unit, cavity, boxOrient, options) {
    const overlapRatio = options.theoreticalOverlapRatio == null
        ? REPLENISHMENT_CONFIG.theoreticalOverlapRatio
        : options.theoreticalOverlapRatio;
    const minSideScale = options.theoreticalVisualMinSideScale == null
        ? REPLENISHMENT_CONFIG.theoreticalVisualMinSideScale
        : options.theoreticalVisualMinSideScale;
    const d = unit.effectiveDims || unit.originalDims;
    const visualDims = options.preserveVisualOriginalDims
        ? (unit.originalDims || d)
        : d;
    const maxL = Math.max(0.2, cavity.l * 0.96);
    const maxW = Math.max(0.2, cavity.w * 0.96);
    const maxH = Math.max(0.2, cavity.h * 0.96);
    const display = options.fitDisplayInsideCavity
        ? dims(
            Math.max(0.12, Math.min(maxL, visualDims.length * (options.visualSideScale || minSideScale))),
            Math.max(0.12, Math.min(maxW, visualDims.width * (options.visualSideScale || minSideScale))),
            Math.max(0.08, Math.min(maxH, visualDims.height * (options.visualHeightScale || minSideScale)))
        )
        : options.preserveVisualOriginalDims ? dims(
            Math.max(0.12, visualDims.length),
            Math.max(0.12, visualDims.width),
            Math.max(0.12, visualDims.height)
        ) : dims(
            Math.max(0.12, Math.min(d.length, Math.max(d.length * minSideScale, maxL))),
            Math.max(0.12, Math.min(d.width, Math.max(d.width * minSideScale, maxW))),
            Math.max(0.12, Math.min(d.height, Math.max(d.height * minSideScale, maxH)))
        );

    const stepScale = Math.max(0.18, 1 - overlapRatio);
    const stepX = Math.max(0.08, display.length * stepScale);
    const stepZ = Math.max(0.08, display.width * stepScale);
    const stepY = Math.max(0.06, display.height * stepScale);
    const cols = Math.max(1, Math.floor(Math.max(0, cavity.l - display.length) / stepX) + 1);
    const rows = Math.max(1, Math.floor(Math.max(0, cavity.w - display.width) / stepZ) + 1);
    const layers = Math.max(1, Math.floor(Math.max(0, cavity.h - display.height) / stepY) + 1);
    const idx = cavity.itemCount || 0;
    const col = idx % cols;
    const row = Math.floor(idx / cols) % rows;
    const layer = Math.floor(idx / (cols * rows)) % layers;
    const wave = Math.floor(idx / Math.max(1, cols * rows * layers));
    const jitter = Math.min(0.08, Math.min(cavity.l, cavity.w, cavity.h) * 0.015);

    const x = _replClamp(cavity.x + col * stepX + (wave % 3) * jitter, 0, boxOrient.length - display.length);
    const z = _replClamp(cavity.y + row * stepZ + (wave % 2) * jitter, 0, boxOrient.width - display.width);
    let y = cavity.z + layer * stepY + (wave % 4) * jitter;
    if (options.preserveVisualOriginalDims && y + display.height > boxOrient.height) {
        y = Math.max(0, boxOrient.height - display.height);
    } else {
        y = _replClamp(y, 0, boxOrient.height - display.height);
    }

    return {
        ...unit,
        x,
        y,
        z,
        length: display.length,
        width: display.width,
        height: display.height,
        cavityId: cavity.idx,
        cavitySource: cavity.source || 'cavity',
        overlapRatio,
        compressionRatio: unit.originalVolume > 0 ? unit.physicalVolume / unit.originalVolume : 1,
        forceVolumeEstimate: !!cavity.forceVolumeEstimate,
        preserveVisualOriginalDims: !!options.preserveVisualOriginalDims,
        visualOverlapDepth: Math.max(0, display.height - cavity.h),
        placementSummary: cavity.forceVolumeEstimate ? '碎片体积强制压缩估算' : '空腔体积压缩填充',
    };
}

function _replClamp(v, min, max) {
    if (max < min) return min;
    return Math.max(min, Math.min(max, v));
}

function _replSoftPreviewColor(idx) {
    const palette = [0x22c55e, 0xa855f7, 0xf59e0b, 0x06b6d4, 0xef4444, 0x84cc16];
    return palette[idx % palette.length];
}

function _replExtractPlacedItems(layers) {
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

function _replVolumeFromPlacedItems(items, useOriginal) {
    return (items || []).reduce((sum, item) => {
        if (useOriginal && item.originalDims) {
            return sum + dimsVolume(item.originalDims);
        }
        return sum + (item.l || 0) * (item.w || 0) * (item.h || 0);
    }, 0);
}

function _replBuildCavities(placedItems, boxInternal) {
    if (typeof buildCavitiesFromPlaced === 'function') {
        return _replFilterCavities(buildCavitiesFromPlaced(placedItems, boxInternal.length, boxInternal.width, boxInternal.height));
    }
    return [{ x: 0, y: 0, z: 0, l: boxInternal.length, w: boxInternal.width, h: boxInternal.height, source: 'initial' }];
}

function _replFilterCavities(cavities) {
    return (cavities || []).filter(_replCavityUsable).sort(_replCavitySort);
}

function _replCavityUsable(c) {
    return c && c.l >= REPLENISHMENT_CONFIG.minCavitySide &&
        c.w >= REPLENISHMENT_CONFIG.minCavitySide &&
        c.h >= REPLENISHMENT_CONFIG.minCavitySide &&
        c.l * c.w * c.h >= REPLENISHMENT_CONFIG.minCavityVolume;
}

function _replCavitySort(a, b) {
    return a.z - b.z || (b.l * b.w * b.h) - (a.l * a.w * a.h);
}

function _replNormalizeCandidate(candidate, boxCount, options) {
    options = options || {};
    const dimsEff = candidate.packagingType === 'soft'
        ? _replSoftEffectiveDims(candidate, options.aggressiveSoftPacking !== false)
        : dimsClone(candidate.dimensions);
    return {
        ...candidate,
        dims: dimsEff,
        maxPerBox: Math.max(0, Math.floor((candidate.maxQty || 0) / Math.max(1, boxCount || 1))),
    };
}

function _replSoftEffectiveDims(candidate, aggressive) {
    const d = candidate.dimensions;
    if (aggressive) {
        return dims(
            Math.max(0.1, d.length * REPLENISHMENT_CONFIG.aggressiveSoftSideScale),
            Math.max(0.1, d.width * REPLENISHMENT_CONFIG.aggressiveSoftSideScale),
            Math.max(0.1, d.height * REPLENISHMENT_CONFIG.aggressiveSoftSideScale)
        );
    }
    if (candidate.softTolerance && candidate.softTolerance > 0) {
        const scale = Math.pow(1 - candidate.softTolerance, 1 / 3);
        return dims(d.length * scale, d.width * scale, d.height * scale);
    }
    const c = CONFIG.softCompress || 2.0;
    return dims(Math.max(0.1, d.length - c), Math.max(0.1, d.width - c), Math.max(0.1, d.height - c));
}

function _replOrientations(d, maxL, maxW, maxH) {
    if (typeof enumerateFitOrientations === 'function') {
        return enumerateFitOrientations(d, maxL, maxW, maxH);
    }
    const all = generateOrientations(d).map(o => ({ l: o.length, w: o.width, h: o.height }));
    return all.filter(o => o.l <= maxL && o.w <= maxW && o.h <= maxH);
}

function _replWithinBox(x, y, z, orient, boxInternal) {
    return x >= -0.01 && y >= -0.01 && z >= -0.01 &&
        x + orient.l <= boxInternal.length + 0.01 &&
        y + orient.w <= boxInternal.width + 0.01 &&
        z + orient.h <= boxInternal.height + 0.01;
}

function _replOverlapsExisting(x, y, z, orient, placedItems) {
    for (const item of placedItems || []) {
        if (boxesOverlap(x, y, z, orient.l, orient.w, orient.h,
            item.x, item.y, item.z, item.l, item.w, item.h)) {
            return true;
        }
    }
    return false;
}

function _replSupportRatio(x, y, z, l, w, placedItems) {
    if (z < 0.01) return 1;
    const footprint = l * w;
    if (footprint <= 0) return 0;
    let support = 0;
    for (const item of placedItems || []) {
        if (Math.abs(item.z + item.h - z) > 0.1) continue;
        const ox = Math.max(0, Math.min(item.x + item.l, x + l) - Math.max(item.x, x));
        const oy = Math.max(0, Math.min(item.y + item.w, y + w) - Math.max(item.y, y));
        support += ox * oy;
    }
    return Math.min(1, support / footprint);
}

function _replFragmentPenalty(cavity, orient) {
    const rem = [
        cavity.l - orient.l,
        cavity.w - orient.w,
        cavity.h - orient.h,
    ].filter(v => v > 0.01);
    return rem.filter(v => v < 1.5).length;
}

function _replSummarizeAdditions(placements, candidates, boxCount, boxVol) {
    const candidateMap = {};
    for (const c of candidates || []) candidateMap[c.id] = c;
    const grouped = {};
    for (const p of placements || []) {
        if (!grouped[p.candidateId]) grouped[p.candidateId] = [];
        grouped[p.candidateId].push(p);
    }

    return Object.entries(grouped).map(([candidateId, items]) => {
        const candidate = candidateMap[candidateId] || {};
        const volume = items.reduce((s, p) => s + p.length * p.width * p.height, 0);
        const lowCount = items.filter(p => p.z < 0.01).length;
        const topCount = items.length - lowCount;
        const warnings = [];
        if (candidate.packagingType === 'soft') warnings.push('软包装按有效压缩尺寸估算，采购前需打样确认');
        if (candidate.packagingType !== 'soft' && topCount > 0) warnings.push('硬包装存在上层放置，需要确认支撑和抗压');
        return {
            candidateId,
            name: candidate.name || items[0].skuName,
            packagingType: candidate.packagingType || items[0].packagingType,
            qtyPerBox: items.length,
            totalQty: items.length * boxCount,
            volumeContribution: boxVol > 0 ? volume / boxVol : 0,
            placements: items,
            placementSummary: lowCount === items.length
                ? '低位/侧边空腔'
                : (lowCount > 0 ? '低位 + 顶部空腔' : '顶部/平台空腔'),
            warnings,
        };
    }).sort((a, b) => b.volumeContribution - a.volumeContribution);
}

function _replMinCandidateSide(candidates) {
    let minSide = Infinity;
    for (const c of candidates || []) {
        const d = c.packagingType === 'soft' ? _replSoftEffectiveDims(c, true) : c.dimensions;
        if (!d) continue;
        minSide = Math.min(minSide, d.length, d.width, d.height);
    }
    return Number.isFinite(minSide) ? minSide : 0.5;
}

function _replGetListedBoxCandidates(currentBoxType, options) {
    options = options || {};
    const source = Array.isArray(options.boxTypes) ? options.boxTypes : [];
    const boxes = [];
    const seen = new Set();
    const addBox = (box) => {
        if (!box || !box.external) return;
        const wall = box.wallThickness || currentBoxType?.wallThickness || CONFIG.defaultWallThickness;
        const external = dims(box.external.length, box.external.width, box.external.height);
        const internal = box.internal
            ? dims(box.internal.length, box.internal.width, box.internal.height)
            : dims(
                Math.max(0.1, external.length - wall * 2),
                Math.max(0.1, external.width - wall * 2),
                Math.max(0.1, external.height - wall * 2)
            );
        const key = [external.length, external.width, external.height]
            .map(v => Number(v).toFixed(1)).sort().join('x');
        if (seen.has(key)) return;
        seen.add(key);
        boxes.push({
            id: box.id || 'box_alt_' + key.replace(/x/g, '_'),
            name: box.name || `${external.length}×${external.width}×${external.height}`,
            external,
            internal,
            wallThickness: wall,
        });
    };
    for (const box of source) addBox(box);
    addBox(currentBoxType);
    return boxes;
}

function _replCloneCavity(c) {
    return { x: c.x, y: c.y, z: c.z, l: c.l, w: c.w, h: c.h, source: c.source };
}

function _replClonePlaced(p) {
    return {
        x: p.x, y: p.y, z: p.z,
        l: p.l, w: p.w, h: p.h,
        skuId: p.skuId, skuName: p.skuName,
        packagingType: p.packagingType,
        originalDims: p.originalDims || null,
    };
}

window.buildReplenishmentCandidates = buildReplenishmentCandidates;
window.generateReplenishmentPlan = generateReplenishmentPlan;
window.generateBoxReplenishmentAlternatives = generateBoxReplenishmentAlternatives;
window.enumerateCandidateFits = enumerateCandidateFits;
window.scoreReplenishmentFit = scoreReplenishmentFit;
window.simulateReplenishmentPlacements = simulateReplenishmentPlacements;
window.summarizeUnusableCavities = summarizeUnusableCavities;
window.buildSoftCompressionPlan = _replBuildTheoreticalSoftPlan;
