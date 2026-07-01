import type { MaterialChannelSource } from '../../systems/lod/terrain/gpu/terrain_material_asset_loader';

/**
 * Per-profile manifest of terrain material source image paths. Index order MUST match
 * TERRAIN_MATERIAL_LAYERS in terrain_render_material.ts (0=regolith_fine, 1=regolith_coarse,
 * 2=basalt_dark, 3=ejecta_bright, 4=rock_face) — the array texture layer index is positional.
 *
 * Paths are root-relative (served directly from public/assets/ by the dev server / production
 * build), not prefixed with ASSETS_URL — unlike the skybox KTX2, these ship with the app.
 */
export const TERRAIN_MATERIAL_ASSET_MANIFEST: Readonly<Record<string, readonly MaterialChannelSource[]>> = {
    selena: [
        { rgb: 'assets/terrain/selena/regolith_fine_albedo.png', alpha: 'assets/terrain/selena/regolith_fine_height.png' },
        { rgb: 'assets/terrain/selena/regolith_coarse_albedo.png', alpha: 'assets/terrain/selena/regolith_coarse_height.png' },
        { rgb: 'assets/terrain/selena/basalt_dark_albedo.png', alpha: 'assets/terrain/selena/basalt_dark_height.png' },
        { rgb: 'assets/terrain/selena/ejecta_bright_albedo.png', alpha: 'assets/terrain/selena/ejecta_bright_height.png' },
        { rgb: 'assets/terrain/selena/rock_face_albedo.png', alpha: 'assets/terrain/selena/rock_face_height.png' }
    ]
};

/**
 * Per-profile manifest of tangent-space normal (rgb) + roughness (alpha) source images
 * (ground-detail-v1.md Step 3). Same layer index order as TERRAIN_MATERIAL_ASSET_MANIFEST.
 * Poly Haven material downloads ship the matching nor_gl.png + rough.png alongside the diffuse
 * map already used for TERRAIN_MATERIAL_ASSET_MANIFEST — no separate sourcing needed.
 */
export const TERRAIN_NORMAL_ROUGHNESS_ASSET_MANIFEST: Readonly<Record<string, readonly MaterialChannelSource[]>> = {
    selena: [
        { rgb: 'assets/terrain/selena/regolith_fine_normal.png', alpha: 'assets/terrain/selena/regolith_fine_roughness.png' },
        { rgb: 'assets/terrain/selena/regolith_coarse_normal.png', alpha: 'assets/terrain/selena/regolith_coarse_roughness.png' },
        { rgb: 'assets/terrain/selena/basalt_dark_normal.png', alpha: 'assets/terrain/selena/basalt_dark_roughness.png' },
        { rgb: 'assets/terrain/selena/ejecta_bright_normal.png', alpha: 'assets/terrain/selena/ejecta_bright_roughness.png' },
        { rgb: 'assets/terrain/selena/rock_face_normal.png', alpha: 'assets/terrain/selena/rock_face_roughness.png' }
    ]
};
