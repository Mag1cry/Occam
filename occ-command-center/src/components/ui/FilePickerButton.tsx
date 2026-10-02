/**
 * 「选择文件」——**系统自带的那个对话框**，选完把正文放进工作区
 *
 * ## 它做的是"放进去"，不是"指过去"
 *
 * 浏览器里的系统对话框**只给文件内容和名字、不给路径**（`File.path` 只有
 * Electron 那类桌面壳里有），而 `task_ref` 要的正是**相对工作区的路径**。所以这一
 * 个按钮干三件事：打开原生对话框 → 把内容 POST 给宿主存进工作区 → 把**落点**
 * 交回去（`onPicked`），由表单填进那一格。
 *
 * 副作用是"点一下就多一个文件"，这一点是**故意**的：字段那一格最后要写的是一个
 * 路径，而路径必须真的存在——不然派发时读不到正文，那次运行会被当场收成 failed。
 *
 * ## 只收文本
 *
 * 正文是文本（`tasks/inputs.py::read` 读的就是 utf-8）。`accept` 是给对话框的提示，
 * 真正拦住的是后端那条上限——选错了文件（比如一个 PDF 或一段视频）它会说清楚。
 *
 * `<input type="file">` 的值**用完要清空**：不清的话，再选同一个文件不会触发
 * `change`（浏览器认为值没变），表现是"点了没反应"。
 */
import { useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { Button } from './Button';
import { uploadWorkspaceFile } from '../../api/gateway';

/** 递给系统对话框的提示。**任务正文是文本**，不是偏好 */
const ACCEPT = '.md,.markdown,.txt,.json,.yaml,.yml,.csv,.log,text/*';

export interface FilePickerButtonProps {
  /** 放进工作区之后：把**落点**（相对工作区的路径）交回去 */
  onPicked: (path: string) => void;
  /** 选不了、存不进去时的原话——由表单显示，不在这儿另写一句 */
  onError?: (message: string) => void;
  disabled?: boolean;
  label?: string;
}

export function FilePickerButton({ onPicked, onError, disabled, label = '选择文件' }: FilePickerButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const path = await uploadWorkspaceFile(file.name, await file.text());
      onPicked(path);
    } catch (caught) {
      onError?.(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || busy}
        /*
          `inline-flex items-center gap-1.5` 是这个仓库里**带图标的按钮**的写法
          （`CommandSurface` / `Badge` 都一样）：按钮默认是 `display: block`，
          图标于是独占一行、文字掉到下面——实测挤成过两行。

          `shrink-0 whitespace-nowrap`：它是"一份固定宽度的动作"，
          不该被旁边的输入框挤扁。
        */
        className="shrink-0 whitespace-nowrap inline-flex items-center gap-1.5"
        onClick={() => input.current?.click()}
      >
        <FileUp className="w-3.5 h-3.5" />
        {busy ? '放进工作区…' : label}
      </Button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        aria-label={label}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // 先清空再处理：不清的话再选同一个文件不会触发 change
          event.target.value = '';
          void pick(file);
        }}
      />
    </>
  );
}
