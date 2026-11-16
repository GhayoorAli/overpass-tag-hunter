import L from 'leaflet';

// leaflet.markercluster is a UMD plugin that attaches itself to the global `L`.
// This module is imported before it so the global exists when the plugin evaluates.
(window as unknown as { L: typeof L }).L = L;

export default L;
