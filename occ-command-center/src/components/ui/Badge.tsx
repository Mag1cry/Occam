/**
 * Badge 组件
 *
 * 状态徽标和数字徽标
 */

import type { HTMLAttributes } from 'react';

interface BadgeProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  size?: 'sm' | 'md';
}

export function Badge({
  variant = 'default',
  size = 'md',
  className = '',
  children,
  ...props
}: BadgeProps) {
  const baseStyles = 'inline-flex items-center justify-center font-medium rounded-full';

  const variantStyles = {
    default: 'bg-occ-unknown/20 text-occ-unknown-light border border-occ-unknown/30',
    success: 'bg-occ-ok/20 text-occ-ok-light border border-occ-ok/30',
    warning: 'bg-occ-warn/20 text-occ-warn-light border border-occ-warn/30',
    danger: 'bg-occ-crit/20 text-occ-crit-light border border-occ-crit/30',
    info: 'bg-occ-accent/20 text-occ-accent-light border border-occ-accent/30',
  };

  const sizeStyles = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-3 py-1 text-sm',
  };

  return (
    <div
      className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
