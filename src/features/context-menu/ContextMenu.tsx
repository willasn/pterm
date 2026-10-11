import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { closeMenu, getMenu, useMenuVersion, type MenuState } from "./store";

/**
 * 单实例业务右键菜单：渲染到 body，越界自动收边，点外部 / Esc / 滚动 / 窗口变化即关闭。
 *
 * 位置需要先量尺寸再收边，所以首次渲染先隐藏（visibility:hidden 仍参与布局），
 * 由 useLayoutEffect 测出尺寸、按视口边界夹取后再显示，避免贴边被裁。
 */
export function ContextMenu() {
  useMenuVersion();
  const state = getMenu();
  const ref = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ state: MenuState; left: number; top: number } | null>(null);

  // 先渲染到 (0,0) 量尺寸，再按视口边界收边
  useLayoutEffect(() => {
    if (!state) return;
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(state.x, window.innerWidth - rect.width - pad));
    const top = Math.max(pad, Math.min(state.y, window.innerHeight - rect.height - pad));
    setPlaced({ state, left, top });
  }, [state]);

  // 打开期间的关闭触发：点外部 / Esc / 滚动 / 失焦 / 改变窗口大小
  useEffect(() => {
    if (!state) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && ref.current.contains(event.target as Node)) return;
      closeMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu();
    };
    const onScroll = () => closeMenu();
    const onBlur = () => closeMenu();
    const onResize = () => closeMenu();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
    };
  }, [state]);

  if (!state) return null;

  const ready = placed !== null && placed.state === state;

  return createPortal(
    <div
      className="ctx-menu"
      role="menu"
      ref={ref}
      style={{ left: ready ? placed.left : 0, top: ready ? placed.top : 0, visibility: ready ? "visible" : "hidden" }}
    >
      {state.items.map((item, index) => {
        if (item.sep) return <div className="ctx-sep" key={index} />;
        const clickable = !item.disabled && typeof item.run === "function";
        return (
          <div
            key={index}
            className={"ctx-item" + (item.danger ? " danger" : "") + (item.disabled ? " disabled" : "")}
            role="menuitem"
            onClick={
              clickable
                ? () => {
                    closeMenu();
                    item.run?.();
                  }
                : undefined
            }
          >
            <span className="ico">{item.icon || ""}</span>
            <span className="label">{item.label || ""}</span>
          </div>
        );
      })}
    </div>,
    document.body
  );
}
