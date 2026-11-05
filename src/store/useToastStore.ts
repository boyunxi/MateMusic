import { create } from "zustand";

export type ToastKind = "info" | "success" | "warning" | "error";

export type ToastInput = {
  kind?: ToastKind;
  message: string;
  duration?: number;
  actionLabel?: string;
  onAction?: () => void;
};

export type Toast = ToastInput & {
  id: number;
  kind: ToastKind;
  duration: number;
};

type ToastState = {
  toasts: Toast[];
  push: (input: ToastInput) => number;
  dismiss: (id: number) => void;
  update: (id: number, patch: Partial<Toast>) => void;
};

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (input) => {
    const id = nextId++;
    const toast: Toast = {
      kind: "info",
      duration: 4500,
      ...input,
      id,
    };
    set((state) => ({ toasts: [...state.toasts, toast] }));
    return id;
  },
  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  update: (id, patch) =>
    set((state) => ({
      toasts: state.toasts.map((toast) =>
        toast.id === id ? { ...toast, ...patch } : toast,
      ),
    })),
}));
