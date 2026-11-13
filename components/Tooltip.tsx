'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /** Tooltip मा देखाइने सामग्री */
  content: ReactNode;
  /** Tooltip trigger गर्ने element */
  children: ReactNode;
  /** Tooltip को स्थान (default: 'top') */
  position?: TooltipPosition;
  /** Trigger बाट tooltip सम्मको दूरी (px, default: 8) */
  offset?: number;
  /** Extra classes wrapper मा */
  className?: string;
}

const POSITION_CLASSES: Record<TooltipPosition, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
};

const ARROW_CLASSES: Record<TooltipPosition, string> = {
  top: 'top-full left-1/2 -translate-x-1/2 border-t-zinc-900 dark:border-t-zinc-100',
  bottom:
    'bottom-full left-1/2 -translate-x-1/2 border-b-zinc-900 dark:border-b-zinc-100',
  left: 'left-full top-1/2 -translate-y-1/2 border-l-zinc-900 dark:border-l-zinc-100',
  right:
    'right-full top-1/2 -translate-y-1/2 border-r-zinc-900 dark:border-r-zinc-100',
};

export default function Tooltip({
  content,
  children,
  position = 'top',
  offset = 8,
  className = '',
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const tooltipId = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);

  const show = useCallback(() => setVisible(true), []);
  const hide = useCallback(() => setVisible(false), []);

  // Escape ले बन्द गर्ने
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visible, hide]);

  // Scroll गर्दा tooltip position बिग्रन नदिन बन्द गर्ने
  useEffect(() => {
    if (!visible) return;
    const onScroll = () => hide();
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [visible, hide]);

  const offsetStyle =
    position === 'top'
      ? { marginBottom: offset }
      : position === 'bottom'
        ? { marginTop: offset }
        : position === 'left'
          ? { marginRight: offset }
          : { marginLeft: offset };

  return (
    <span
      ref={wrapperRef}
      className={`relative inline-flex ${className}`.trim()}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span aria-describedby={visible ? tooltipId : undefined}>{children}</span>
      {visible && (
        <span
          id={tooltipId}
          role="tooltip"
          style={offsetStyle}
          className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900 ${POSITION_CLASSES[position]}`}
        >
          {content}
          <span
            aria-hidden="true"
            className={`absolute h-0 w-0 border-4 border-transparent ${ARROW_CLASSES[position]}`}
          />
        </span>
      )}
    </span>
  );
}
