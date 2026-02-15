import L from 'leaflet';
import { STOP_TYPE_CONFIG } from '../../lib/stop-type-config';
import type { StopType } from '../../lib/types';

const CUSTOM_STOP_TOUCH_TARGET_PX = 38;
const CUSTOM_STOP_MARKER_RING_BORDER_PX = 3;
const CUSTOM_STOP_MARKER_CROSS_THICKNESS_PX = 2;

export function createCustomStopMarkerIcon(stopType: StopType, color: string): L.DivIcon {
  const targetSize = CUSTOM_STOP_TOUCH_TARGET_PX;
  const ringSize = Math.max(18, STOP_TYPE_CONFIG[stopType].markerRadius * 3 + 4);
  const coreSize = Math.max(6, Math.round(STOP_TYPE_CONFIG[stopType].markerRadius * 1.6));
  const crossSize = ringSize - 8;

  return L.divIcon({
    className: 'custom-stop-drag-marker',
    iconSize: [targetSize, targetSize],
    iconAnchor: [targetSize / 2, targetSize / 2],
    popupAnchor: [0, -(targetSize / 2)],
    html: `
      <span
        aria-hidden="true"
        style="
          width:${targetSize}px;
          height:${targetSize}px;
          display:flex;
          align-items:center;
          justify-content:center;
          touch-action:none;
        "
      >
        <span
          style="
            width:${ringSize}px;
            height:${ringSize}px;
            border-radius:999px;
            background:#ffffff;
            border:${CUSTOM_STOP_MARKER_RING_BORDER_PX}px solid ${color};
            box-shadow:0 0 0 1px #ffffff, 0 2px 6px rgba(0, 0, 0, 0.35);
            display:flex;
            align-items:center;
            justify-content:center;
            position:relative;
          "
        >
          <span
            style="
              position:absolute;
              width:${crossSize}px;
              height:${CUSTOM_STOP_MARKER_CROSS_THICKNESS_PX}px;
              border-radius:999px;
              background:${color};
              opacity:0.7;
            "
          ></span>
          <span
            style="
              position:absolute;
              width:${CUSTOM_STOP_MARKER_CROSS_THICKNESS_PX}px;
              height:${crossSize}px;
              border-radius:999px;
              background:${color};
              opacity:0.7;
            "
          ></span>
          <span
            style="
              width:${coreSize}px;
              height:${coreSize}px;
              border-radius:999px;
              background:${color};
            "
          ></span>
        </span>
      </span>
    `,
  });
}
