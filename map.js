/**
 * MoniRail Web Rider — Map Layer  (map.js)
 *
 * Wraps Leaflet.js to provide:
 *   • Live position marker
 *   • Journey polyline (coloured route)
 *   • Coloured event markers (green / amber / red)
 *   • Tap-to-view event detail popup
 *
 * All Leaflet specifics are contained here; the rest of the app
 * calls only the public API (init, updatePosition, addEvent, reset).
 */

const MapModule = (() => {

  let _map          = null;
  let _posMarker    = null;
  let _routeLine    = null;
  let _routePoints  = [];   // [L.LatLng, ...]  — full journey path
  let _eventMarkers = [];   // { id, marker } — for later removal if needed

  const SEVERITY_COLOR = {
    INFO:     '#4caf50',   // green
    WARNING:  '#ff9800',   // amber
    CRITICAL: '#f44336',   // red
  };

  // SVG pulse icon for current position
  function _posIcon() {
    return L.divIcon({
      className: '',
      html: `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
               <circle cx="12" cy="12" r="6" fill="#00bcd4" stroke="#fff" stroke-width="2"/>
               <circle cx="12" cy="12" r="10" fill="none" stroke="#00bcd4" stroke-width="1.5" opacity="0.5"/>
             </svg>`,
      iconSize:   [24, 24],
      iconAnchor: [12, 12],
    });
  }

  /** Create a small coloured circle marker for an event. */
  function _eventIcon(severity) {
    const color = SEVERITY_COLOR[severity] || SEVERITY_COLOR.INFO;
    return L.divIcon({
      className: '',
      html: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
               <circle cx="8" cy="8" r="6" fill="${color}" stroke="#fff" stroke-width="1.5"/>
             </svg>`,
      iconSize:   [16, 16],
      iconAnchor: [8, 8],
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Initialise the Leaflet map inside the given DOM element id.
   * Must be called once after the page is loaded.
   */
  function init(containerId) {
    _map = L.map(containerId, {
      center:  [CONFIG.map.DEFAULT_LAT, CONFIG.map.DEFAULT_LNG],
      zoom:    CONFIG.map.DEFAULT_ZOOM,
      zoomControl:       true,
      attributionControl: true,
    });

    L.tileLayer(CONFIG.map.TILE_URL, {
      attribution: CONFIG.map.ATTRIBUTION,
      maxZoom: 19,
    }).addTo(_map);

    // Initialise empty route polyline
    _routeLine = L.polyline([], {
      color:  '#00bcd4',
      weight: 3,
      opacity: 0.85,
    }).addTo(_map);

    // Position marker (hidden until first GPS fix)
    _posMarker = L.marker([0, 0], { icon: _posIcon(), zIndexOffset: 1000 });

    return _map;
  }

  /**
   * Update the live position marker and extend the route polyline.
   * Called approximately once per second from app.js.
   *
   * @param {number} lat
   * @param {number} lng
   * @param {boolean} followCamera  — if true, pan map to keep position in view
   */
  function updatePosition(lat, lng, followCamera = true) {
    if (!_map) return;
    const ll = L.latLng(lat, lng);

    if (!_map.hasLayer(_posMarker)) {
      _posMarker.setLatLng(ll).addTo(_map);
      _map.setView(ll, CONFIG.map.DEFAULT_ZOOM);
    } else {
      _posMarker.setLatLng(ll);
    }

    _routePoints.push(ll);
    _routeLine.setLatLngs(_routePoints);

    if (followCamera) {
      _map.panTo(ll, { animate: true, duration: 0.5 });
    }
  }

  /**
   * Add a coloured event marker at the given coordinates.
   *
   * @param {object} evt — event record from EventModule
   */
  function addEvent(evt) {
    if (!_map || evt.latitude == null || evt.longitude == null) return;

    const icon   = _eventIcon(evt.severity);
    const marker = L.marker([evt.latitude, evt.longitude], { icon });

    const utcStr = evt.utc_iso ? evt.utc_iso.replace('T', ' ').slice(0, 19) : '—';
    const val    = evt.peak_value != null
      ? `${evt.peak_value.toFixed(3)} ${evt.units}`
      : '—';

    marker.bindPopup(
      `<div class="map-popup">
         <strong>${evt.event_type.replace(/_/g, ' ')}</strong><br>
         <span class="popup-time">${utcStr}</span><br>
         Peak: <strong>${val}</strong><br>
         Severity: <span class="popup-sev popup-sev-${evt.severity.toLowerCase()}">${evt.severity}</span>
       </div>`,
      { maxWidth: 220 }
    );
    marker.addTo(_map);
    _eventMarkers.push({ id: evt.event_id, marker });
  }

  /**
   * Show a popup for a specific event from the events table.
   */
  function focusEvent(eventId) {
    const found = _eventMarkers.find(e => e.id === eventId);
    if (found) {
      _map.panTo(found.marker.getLatLng(), { animate: true });
      found.marker.openPopup();
    }
  }

  /** Force Leaflet to recalculate its size after the container is resized. */
  function invalidateSize() {
    if (_map) _map.invalidateSize();
  }

  /** Clear the route and all event markers (called at start of new recording). */
  function reset() {
    _routePoints = [];
    if (_routeLine) _routeLine.setLatLngs([]);
    _eventMarkers.forEach(e => _map && _map.removeLayer(e.marker));
    _eventMarkers = [];
    if (_posMarker && _map && _map.hasLayer(_posMarker)) {
      _map.removeLayer(_posMarker);
    }
  }

  return { init, updatePosition, addEvent, focusEvent, invalidateSize, reset };

})();
