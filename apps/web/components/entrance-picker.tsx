'use client';
import { useEffect, useState } from 'react';
import { entranceDistance, type EntranceRequest } from '@/lib/entrances';
import { validLocation } from '@/lib/community-core';

type MapClick = { lnglat: { getLng(): number; getLat(): number } };
export type EntranceMap = {
  on(event: 'click', handler: (event: MapClick) => void): void;
  off(event: 'click', handler: (event: MapClick) => void): void;
  setZoomAndCenter(
    zoom: number,
    center: [number, number],
    immediately: boolean,
  ): void;
};
export function EntrancePicker({
  request,
  map,
  marker,
  onClose,
}: {
  request: EntranceRequest;
  map: EntranceMap;
  marker: (location: string, label: string) => { setMap(value: null): void };
  onClose: () => void;
}) {
  const [location, setLocation] = useState(request.place.location);
  const [error, setError] = useState('');
  const original = request.place.originalLocation ?? request.place.location;
  useEffect(() => {
    map.setZoomAndCenter(
      17,
      request.place.location.split(',').map(Number) as [number, number],
      true,
    );
    const handler = (e: MapClick) => {
      setLocation(
        `${e.lnglat.getLng().toFixed(6)},${e.lnglat.getLat().toFixed(6)}`,
      );
      setError('');
    };
    map.on('click', handler);
    return () => map.off('click', handler);
  }, [map, request]);
  useEffect(() => {
    const origin = marker(original, '原 POI');
    const chosen = validLocation(location)
      ? marker(location, '待保存入口')
      : undefined;
    return () => {
      origin.setMap(null);
      chosen?.setMap(null);
    };
  }, [original, location, marker]);
  return (
    <section
      className="entrance-picker"
      role="dialog"
      aria-label="校正实际入口"
      aria-modal="false"
    >
      <strong>
        {request.kind === 'company' ? '公司' : '小区'}入口 ·{' '}
        {request.place.name}
      </strong>
      <p>点击地图选择实际大门，再确认保存。不请求路线；保存后旧核验失效。</p>
      <small>原位置：{original}</small>
      <label>
        入口坐标（高德 GCJ-02）
        <input
          aria-label="入口坐标"
          value={location}
          onChange={(e) => setLocation(e.target.value.trim())}
        />
      </label>
      {validLocation(location) && (
        <small>
          距原位置约 {Math.round(entranceDistance(original, location))} 米
        </small>
      )}
      {error && <p role="alert">{error}</p>}
      <div>
        <button type="button" onClick={() => setLocation(original)}>
          恢复原 POI 位置
        </button>
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          onClick={() => {
            if (
              !validLocation(location) ||
              entranceDistance(original, location) > 3000
            ) {
              setError('请输入有效坐标，且距原位置不超过 3 公里。');
              return;
            }
            try {
              request.onSave(location);
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : '保存失败');
            }
          }}
        >
          确认保存入口
        </button>
      </div>
    </section>
  );
}
