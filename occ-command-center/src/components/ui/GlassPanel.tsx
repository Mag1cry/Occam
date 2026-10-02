/**
 * GlassPanel 组件
 *
 * 通用玻璃态面板，用于悬浮 Overlay
 */

import type { HTMLAttributes } from 'react';

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'strong';
}

export function GlassPanel({
  variant = 'default',
  className = '',
  children,
  ...props
}: GlassPanelProps) {
  const baseStyles = 'rounded-lg';

  const variantStyles = {
    default: 'glass',
    strong: 'glass-strong',
  };

  return (
    <div className={`${baseStyles} ${variantStyles[variant]} ${className}`} {...props}>
      {children}
    </div>
  );
}
