export type MapView = 'transit' | 'communities';
export type Viewport = { center: [number, number]; zoom: number };
export type ViewportMap = {
  getCenter(): { toJSON(): [number, number] };
  getZoom(): number;
  setZoomAndCenter(
    zoom: number,
    center: [number, number],
    immediately: boolean,
  ): void;
};
export function captureViewport(map: ViewportMap): Viewport {
  return { center: [...map.getCenter().toJSON()], zoom: map.getZoom() };
}
export function restoreViewport(map: ViewportMap, viewport: Viewport) {
  map.setZoomAndCenter(viewport.zoom, viewport.center, true);
}
export function visibleMapRoutes<T extends { logicalId: string }>(
  routes: T[],
  onlyCurrent: boolean,
  activeId: string,
) {
  return onlyCurrent
    ? routes.filter((route) => route.logicalId === activeId)
    : routes;
}
