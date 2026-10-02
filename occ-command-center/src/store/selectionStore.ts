/**
 * Selection Store
 *
 * 选中态的唯一事实来源。画布不持有第二份选中状态：
 * 节点数组每次重算都会整体替换 React Flow 的节点对象，
 * 选中态如果挂在那些对象上，平移、缩放或布局变化会把它一起冲掉。
 */

import { create } from 'zustand';

interface SelectionStoreState {
  /** 选中的节点 ID */
  selectedNodeId: string | null;

  /** 直接设置选中（长按、列表点击等非画布轻点路径） */
  setSelected: (nodeId: string | null) => void;

  /**
   * 轻点节点：未选中则选中，已选中则取消
   *
   * 只有画布的单次轻点走这里。双击进入场景、长按打开操作牌
   * 这类路径用 setSelected，避免被开关语义意外取消。
   */
  toggleSelected: (nodeId: string) => void;
}

export const useSelectionStore = create<SelectionStoreState>((set) => ({
  selectedNodeId: null,

  setSelected: (nodeId) => {
    set({ selectedNodeId: nodeId });
  },

  toggleSelected: (nodeId) => {
    set((state) => ({
      selectedNodeId: state.selectedNodeId === nodeId ? null : nodeId,
    }));
  },
}));
