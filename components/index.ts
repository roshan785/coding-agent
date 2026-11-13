// Barrel export for shared UI components.
// Import cleanly: `import { Button, Input, Modal, Tooltip } from '@/components';`

export { default as Badge } from './Badge';
export type { BadgeProps, BadgeVariant } from './Badge';

export { default as Button } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button';

export {
  default as Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from './Card';
export type {
  CardProps,
  CardSectionProps,
  CardTitleProps,
  CardDescriptionProps,
} from './Card';

export { default as Greeting } from './Greeting';
export type { GreetingProps } from './Greeting';

export { default as Test } from './Test';
export type { TestProps } from './Test';

export { default as Input } from './Input';
export type { InputProps, InputSize } from './Input';

export { default as Modal } from './Modal';
export type { ModalProps } from './Modal';

export { default as Tooltip } from './Tooltip';
export type { TooltipProps, TooltipPosition } from './Tooltip';
