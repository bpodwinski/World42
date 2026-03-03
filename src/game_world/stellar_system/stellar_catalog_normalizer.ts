import type {
    LodAlgorithm,
    StellarCatalogJSON,
    StellarSystemJSON,
    SystemJSON,
} from './stellar_catalog_loader';

function canonicalType(typeRaw: unknown): string {
    let type = (typeof typeRaw === 'string' ? typeRaw : 'planet').toLowerCase().trim();
    if (type === 'sun') type = 'star';
    return type;
}

function canonicalLodAlgorithm(value: unknown): LodAlgorithm {
    if (typeof value !== 'string') return 'cdlod';
    return value.toLowerCase().trim() === 'cbt' ? 'cbt' : 'cdlod';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null) return null;
    return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | undefined {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function asVec3(value: unknown): [number, number, number] | undefined {
    if (!Array.isArray(value) || value.length !== 3) return undefined;
    const x = asFiniteNumber(value[0]);
    const y = asFiniteNumber(value[1]);
    const z = asFiniteNumber(value[2]);
    if (x === undefined || y === undefined || z === undefined) return undefined;
    return [x, y, z];
}

export function normalizeCatalogJSON(raw: unknown): StellarCatalogJSON {
    const root = asRecord(raw);
    const systemsRaw = root ? asRecord(root.systems) : null;

    if (systemsRaw) {
        const systems: Record<string, StellarSystemJSON> = {};

        for (const [systemId, systemUnknown] of Object.entries(systemsRaw)) {
            const systemRecord = asRecord(systemUnknown);
            const bodiesRaw = systemRecord ? systemRecord.bodies ?? systemUnknown : systemUnknown;
            systems[systemId] = {
                origin_km: systemRecord ? asVec3(systemRecord.origin_km) : undefined,
                displayName:
                    systemRecord && typeof systemRecord.displayName === 'string'
                        ? systemRecord.displayName
                        : undefined,
                bodies: normalizeSystemJSON(bodiesRaw),
            };
        }

        return {
            systems,
            default: typeof root?.default === 'string' ? root.default : undefined,
        };
    }

    return {
        systems: {
            Sol: { bodies: normalizeSystemJSON(raw) },
        },
        default: 'Sol',
    };
}

export function normalizeSystemJSON(raw: unknown): SystemJSON {
    const result: SystemJSON = {};
    const source = asRecord(raw);
    if (!source) return result;

    for (const [name, bodyUnknown] of Object.entries(source)) {
        const body = asRecord(bodyUnknown) ?? {};
        const position = asVec3(body.position_km) ?? [0, 0, 0];
        const diameterKm = asFiniteNumber(body.diameter_km ?? body.diameter) ?? 0;
        const rotationRaw = body.rotation_period_days;
        const rotationPeriodDays =
            rotationRaw === null || rotationRaw === undefined
                ? null
                : asFiniteNumber(rotationRaw) ?? null;

        const starRecord = asRecord(body.star);
        const colorRGB = starRecord ? asVec3(starRecord.color_rgb) : undefined;

        result[name] = {
            type: canonicalType(body.type ?? body.Type),
            position_km: position,
            diameter_km: diameterKm,
            rotation_period_days: rotationPeriodDays,
            lod_algorithm: canonicalLodAlgorithm(body.lod_algorithm ?? body.lodAlgorithm),
            star: starRecord
                ? {
                    temperature_k: asFiniteNumber(starRecord.temperature_k),
                    intensity: asFiniteNumber(starRecord.intensity),
                    color_rgb: colorRGB,
                }
                : undefined,
        };
    }

    return result;
}
