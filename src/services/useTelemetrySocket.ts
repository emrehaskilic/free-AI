import { useEffect, useRef, useState } from 'react';
import { MetricsMessage, MetricsState } from '../types/metrics';
import { proxyWebSocketProtocols } from './proxyAuth';
import { getProxyWsBase } from './proxyBase';

/**
 * Hook that connects to the backend telemetry WebSocket and
 * accumulates per‑symbol metrics.  The server emits both raw Binance
 * messages and separate ``metrics`` messages.  We listen only for
 * ``metrics`` messages and update local state accordingly.  A new
 * WebSocket connection is opened whenever the list of active symbols
 * changes.
 *
 * The hook returns a map keyed by symbol.  Each entry holds the
 * latest ``MetricsMessage`` for that symbol.  The UI should treat
 * this object as immutable and re-render when it changes.
 */
export function useTelemetrySocket(activeSymbols: string[]): MetricsState {
  const [state, setState] = useState<MetricsState>({});
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttempts = useRef(0);
  const normalizedSymbols = Array.from(
    new Set(
      activeSymbols
        .map((symbol) => String(symbol || '').trim().toUpperCase())
        .filter(Boolean)
    )
  ).sort();
  const symbolsKey = normalizedSymbols.join(',');

  useEffect(() => {
    let disposed = false;
    const maxDelayMs = 30_000;
    reconnectAttempts.current = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimeoutRef.current !== null) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || normalizedSymbols.length === 0) {
        return;
      }
      if (reconnectTimeoutRef.current !== null) {
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), maxDelayMs);
      reconnectAttempts.current += 1;
      console.log(`[Telemetry] Reconnecting in ${delay}ms...`);
      reconnectTimeoutRef.current = window.setTimeout(() => {
        reconnectTimeoutRef.current = null;
        connect();
      }, delay);
    };

    const closeActiveSocket = (reason: string) => {
      const current = wsRef.current;
      if (!current) {
        return;
      }
      wsRef.current = null;
      try {
        if (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING) {
          current.close(1000, reason);
        }
      } catch {
        // Ignore close failures on teardown.
      }
    };

    const connect = () => {
      if (disposed || normalizedSymbols.length === 0) {
        return;
      }

      clearReconnectTimer();
      closeActiveSocket('reconnect');

      const proxyWs = getProxyWsBase();
      const url = `${proxyWs}/ws?symbols=${normalizedSymbols.join(',')}`;
      console.log(`[Telemetry] Connecting to WS: ${url} (attempt ${reconnectAttempts.current + 1})`);

      try {
        const ws = new WebSocket(url, proxyWebSocketProtocols());
        wsRef.current = ws;

        ws.onopen = () => {
          if (disposed || wsRef.current !== ws) {
            return;
          }
          console.log('[Telemetry] WebSocket connected');
          reconnectAttempts.current = 0;
        };

        ws.onmessage = (event) => {
          if (disposed || wsRef.current !== ws) {
            return;
          }
          if (typeof event.data !== 'string') {
            return;
          }
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'metrics' && msg.symbol) {
              const metricsMsg = msg as MetricsMessage;
              setState(prev => ({ ...prev, [metricsMsg.symbol]: metricsMsg }));
            }
          } catch {
            // Ignore parse errors
          }
        };

        ws.onclose = (event) => {
          if (disposed) {
            return;
          }
          if (wsRef.current !== ws) {
            return;
          }
          wsRef.current = null;
          console.log(`[Telemetry] WebSocket closed (code: ${event.code})`);
          scheduleReconnect();
        };

        ws.onerror = (error) => {
          if (disposed || wsRef.current !== ws) {
            return;
          }
          console.error('[Telemetry] WebSocket error:', error);
          // onclose handles reconnect.
        };
      } catch (error) {
        if (disposed) {
          return;
        }
        console.error('[Telemetry] Failed to create WebSocket:', error);
        scheduleReconnect();
      }
    };

    connect();

    return () => {
      disposed = true;
      clearReconnectTimer();
      closeActiveSocket('effect_cleanup');
    };
  }, [symbolsKey]);

  return state;
}
