import type { ExternalToast, ToasterProps } from "sonner";
import { Toaster as SonnerToaster, toast as sonnerToast } from "sonner";

function Toaster(props: ToasterProps) {
  const { toastOptions, mobileOffset, offset, ...restProps } = props;
  return (
    <SonnerToaster
      richColors
      position="top-right"
      offset={offset ?? 20}
      mobileOffset={mobileOffset ?? 12}
      toastOptions={{
        ...toastOptions,
        closeButtonAriaLabel: toastOptions?.closeButtonAriaLabel ?? "关闭提示",
        classNames: {
          ...toastOptions?.classNames,
          toast: `max-w-[calc(100vw-1.5rem)] overflow-visible ${toastOptions?.classNames?.toast ?? ""}`.trim(),
          content: `min-w-0 break-words [overflow-wrap:anywhere] ${toastOptions?.classNames?.content ?? ""}`.trim(),
          title: `break-words [overflow-wrap:anywhere] ${toastOptions?.classNames?.title ?? ""}`.trim(),
          description: `break-words [overflow-wrap:anywhere] ${toastOptions?.classNames?.description ?? ""}`.trim(),
          closeButton: `shadow-sm ${toastOptions?.classNames?.closeButton ?? ""}`.trim(),
        },
      }}
      {...restProps}
    />
  );
}

const ERROR_TOAST_DEFAULTS: ExternalToast = {
  // Keep errors visible long enough to read, but do not permanently cover action buttons.
  duration: 12_000,
  closeButton: true,
  dismissible: true,
};

const toast = Object.assign(
  (
    message: Parameters<typeof sonnerToast>[0],
    data?: Parameters<typeof sonnerToast>[1],
  ) => {
    sonnerToast.dismiss();
    return sonnerToast(message, data);
  },
  sonnerToast,
  {
    success: (
      message: Parameters<typeof sonnerToast.success>[0],
      data?: Parameters<typeof sonnerToast.success>[1],
    ) => {
      sonnerToast.dismiss();
      return sonnerToast.success(message, data);
    },
    error: (
      message: Parameters<typeof sonnerToast.error>[0],
      data?: Parameters<typeof sonnerToast.error>[1],
    ) => {
      sonnerToast.dismiss();
      return sonnerToast.error(message, {
        ...ERROR_TOAST_DEFAULTS,
        ...data,
      });
    },
  },
);

export { Toaster, toast };
