/**
 * Button 组件
 *
 * 基础按钮组件，符合 Palantir AIP 专业风格
 */

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className = '', children, ...props }, ref) => {
    /*
      **禁用必须看得出来。** 以前一个 `disabled:` 类都没有，`disabled` 只是透传给
      HTML——于是禁用的按钮和可用的一模一样（实心蓝、hover 还会亮），用户点了没反应，
      只能以为界面坏了。`disabled` 是浏览器自己认的属性，样式却没跟上，那是样式的错。
    */
    const baseStyles = 'transition-smooth font-medium rounded focus:outline-none focus:ring-2 '
      + 'focus:ring-offset-2 disabled:opacity-40 disabled:cursor-not-allowed';

    const variantStyles = {
      // hover 一律走 `enabled:`——禁用的按钮不该在鼠标划过时亮起来
      primary: 'bg-occ-accent enabled:hover:bg-occ-accent-light text-white focus:ring-occ-accent',
      secondary: 'glass enabled:hover:bg-white/10 text-white focus:ring-occ-unknown',
      danger: 'bg-occ-crit enabled:hover:bg-occ-crit-light text-white focus:ring-occ-crit',
    };

    const sizeStyles = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-4 py-2 text-base',
      lg: 'px-6 py-3 text-lg',
    };

    return (
      <button
        ref={ref}
        className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
