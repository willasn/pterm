import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** 将弹窗渲染到 body，避开外壳布局与层叠上下文。 */
export function Portal({ selector, children }: { selector: string; children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(document.querySelector<HTMLElement>(selector));
  }, [selector]);

  if (!target) return null;
  return createPortal(children, target);
}
