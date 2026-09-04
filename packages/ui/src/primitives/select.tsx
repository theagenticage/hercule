import type { ComponentProps, JSX } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { cn } from "./cn";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>): JSX.Element {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "inline-flex w-full cursor-pointer items-center justify-between gap-2 rounded-control",
        "border border-line bg-raised px-2.5 py-1.5 text-body text-ink",
        "focus-visible:border-live focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="text-faint">
        <svg viewBox="0 0 12 12" width={12} height={12} fill="none" aria-hidden="true">
          <path
            d="m3.2 4.8 2.8 2.8 2.8-2.8"
            stroke="currentColor"
            strokeWidth={1.15}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>): JSX.Element {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={4}
        className={cn(
          "z-30 overflow-hidden rounded-card border border-line bg-raised p-1 shadow-lift",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>): JSX.Element {
  return (
    <SelectPrimitive.Item
      className={cn(
        "flex cursor-pointer items-baseline gap-2 rounded-control px-2 py-1.5 text-row text-ink outline-none",
        "data-[highlighted]:bg-line-soft",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
