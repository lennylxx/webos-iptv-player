export const LICENSE_TYPE_KEYS = [
  'inputstream.adaptive.license_type',
  'license_type',
  'drm_type',
];
export const DRM_KEYS = ['inputstream.adaptive.drm'];
export const DRM_LEGACY_KEYS = [
  'inputstream.adaptive.drm_legacy',
  'drm_legacy',
];
export const LICENSE_KEY_KEYS = [
  'inputstream.adaptive.license_key',
  'license_key',
  'drm_license_url',
];
export const CUSTOM_DATA_KEYS = ['drm_custom_data'];
export const LICENSE_DATA_KEYS = [
  'inputstream.adaptive.license_data',
  'license_data',
];

/** Every playlist option parseDrmConfig reads. */
export const DRM_OPTION_KEYS: readonly string[] = [
  ...LICENSE_TYPE_KEYS,
  ...DRM_KEYS,
  ...DRM_LEGACY_KEYS,
  ...LICENSE_KEY_KEYS,
  ...CUSTOM_DATA_KEYS,
  ...LICENSE_DATA_KEYS,
];
