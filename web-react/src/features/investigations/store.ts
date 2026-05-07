import { create } from "zustand";
import type { InvestigationDraft } from "@/features/investigations/buildSpanInvestigationDraft";

type InvestigationModalState = {
  open: boolean;
  draft: InvestigationDraft | undefined;
  openWith: (draft: InvestigationDraft) => void;
  close: () => void;
};

export const useInvestigationModal = create<InvestigationModalState>((set) => ({
  open: false,
  draft: undefined,
  openWith: (draft) => set({ open: true, draft }),
  close: () => set({ open: false, draft: undefined }),
}));
