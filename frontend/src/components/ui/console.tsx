import React from "react";
import { ChevronDown, AlertCircle, CheckCircle, X } from "lucide-react";

// Helper for class consolidation
const cls = (...classes: any[]) => classes.filter(Boolean).join(" ");

// 1. Box
export function Box({ children, variant, color, textAlign, padding }: any) {
  const style: React.CSSProperties = {
    textAlign: textAlign || "left",
    padding: padding === "l" ? "24px" : padding === "m" ? "16px" : padding === "s" ? "8px" : undefined,
    color: color === "text-body-secondary" ? "var(--text-3)" : undefined,
  };
  return <div style={style}>{children}</div>;
}

// 2. Spinner
export function Spinner({ size }: any) {
  const s = size === "large" ? "32px" : "18px";
  return (
    <div
      style={{
        display: "inline-block",
        width: s,
        height: s,
        border: "2px solid var(--border-3)",
        borderTopColor: "var(--accent)",
        borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
      }}
    />
  );
}

export function Button({ children, onClick, disabled, variant, loading, href, target, rel, ariaLabel }: any) {
  const className = cls(
    "btn",
    variant === "primary" ? "primary" : variant === "link" || variant === "icon" || variant === "inline-link" ? "ghost" : ""
  );
  const style: React.CSSProperties = {
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    textDecoration: "none",
  };
  if (href) {
    return (
      <a href={href} target={target} rel={rel} className={className} style={style} aria-label={ariaLabel}>
        {loading && <Spinner />}
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className={className}
      aria-label={ariaLabel}
      style={style}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}


// 4. Input
export const Input = React.forwardRef(({ value, onChange, placeholder, disabled, type, inputMode, readOnly, ariaLabel }: any, ref: any) => {
  return (
    <div className="field" style={{ width: "100%", opacity: disabled ? 0.6 : 1 }}>
      <input
        ref={ref}
        type={type || "text"}
        value={value ?? ""}
        onChange={(e) => onChange?.({ detail: { value: e.target.value } })}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        readOnly={readOnly}
        aria-label={ariaLabel}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          outline: "none",
          color: "var(--text)",
        }}
      />
    </div>
  );
});

// 5. Select
export function Select({ selectedOption, onChange, options, placeholder, disabled, filteringType, empty }: any) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const clickAway = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", clickAway);
    return () => document.removeEventListener("mousedown", clickAway);
  }, []);

  const currentLabel = selectedOption?.label || selectedOption?.value || placeholder || "Choose an option";

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", minWidth: "160px" }}>
      <button
        type="button"
        className="field"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          textAlign: "left",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentLabel}</span>
        <ChevronDown size={14} style={{ color: "var(--text-3)" }} />
      </button>

      {open && (
        <div
          className="scroller"
          style={{
            position: "absolute",
            top: "105%",
            left: 0,
            width: "100%",
            background: "var(--surface-2)",
            border: "1px solid var(--border-3)",
            borderRadius: "var(--r-sm)",
            zIndex: 1000,
            maxHeight: "240px",
            overflowY: "auto",
            boxShadow: "var(--shadow)",
          }}
        >
          {options.length === 0 ? (
            <div style={{ padding: "10px 12px", color: "var(--text-3)", fontSize: "12.5px" }}>{empty || "No options"}</div>
          ) : (
            options.map((opt: any) => {
              const sel = selectedOption?.value === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onChange?.({ detail: { selectedOption: opt } });
                    setOpen(false);
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: sel ? "var(--accent-soft)" : "transparent",
                    color: sel ? "var(--text)" : "var(--text-2)",
                    border: "none",
                    padding: "8px 12px",
                    cursor: "pointer",
                    fontSize: "13px",
                  }}
                  onMouseEnter={(e) => {
                    if (!sel) e.currentTarget.style.background = "var(--surface-3)";
                  }}
                  onMouseLeave={(e) => {
                    if (!sel) e.currentTarget.style.background = "transparent";
                  }}
                >
                  {opt.label || opt.value}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// 6. Toggle
export function Toggle({ checked, onChange, disabled, children }: any) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 10, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 }}>
      <div
        style={{
          width: 38,
          height: 20,
          borderRadius: 99,
          background: checked ? "var(--accent)" : "var(--surface-3)",
          position: "relative",
          transition: "background 0.2s",
          border: "1px solid var(--border-2)",
        }}
      >
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "#fff",
            position: "absolute",
            top: 2,
            left: checked ? 20 : 2,
            transition: "left 0.2s",
          }}
        />
      </div>
      {children && <span style={{ fontSize: "13px", color: "var(--text)" }}>{children}</span>}
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange?.({ detail: { checked: e.target.checked } })}
        style={{ display: "none" }}
      />
    </label>
  );
}

// 7. Checkbox
export function Checkbox({ checked, onChange, disabled, children }: any) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 }}>
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange?.({ detail: { checked: e.target.checked } })}
        style={{
          accentColor: "var(--accent)",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      />
      {children && <span style={{ fontSize: "13px", color: "var(--text)" }}>{children}</span>}
    </label>
  );
}

// 8. Textarea
export function Textarea({ value, onChange, placeholder, disabled, rows }: any) {
  return (
    <div style={{ border: "1px solid var(--border-2)", background: "var(--bg-2)", borderRadius: "var(--r-sm)", padding: "8px 12px" }}>
      <textarea
        value={value ?? ""}
        onChange={(e) => onChange?.({ detail: { value: e.target.value } })}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows || 3}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          outline: "none",
          color: "var(--text)",
          fontFamily: "var(--sans)",
          fontSize: "13.5px",
          resize: "vertical",
        }}
      />
    </div>
  );
}

// 9. Tabs
export function Tabs({ tabs, activeTabId, onChange, variant }: any) {
  const currentTab = activeTabId || tabs[0]?.id;
  const tabItem = tabs.find((t: any) => t.id === currentTab);

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
      <div className="seg" style={{ marginBottom: 16, alignSelf: "flex-start" }}>
        {tabs.map((tab: any) => {
          const isSelected = tab.id === currentTab;
          return (
            <button
              key={tab.id}
              type="button"
              className={isSelected ? "on" : ""}
              onClick={() => onChange?.({ detail: { activeTabId: tab.id } })}
              style={{
                background: isSelected ? "var(--surface-2)" : "transparent",
                color: isSelected ? "var(--text)" : "var(--text-3)",
                border: "none",
                cursor: "pointer",
                padding: "6px 12px",
                borderRadius: "7px",
                fontWeight: 600,
                fontSize: "12.5px",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div style={{ width: "100%" }}>{tabItem?.content}</div>
    </div>
  );
}

// 10. Container
export function Container({ children, header, footer }: any) {
  return (
    <div
      style={{
        borderRadius: "var(--r-lg)",
        border: "1px solid var(--border)",
        background: "var(--surface)",
        overflow: "hidden",
        boxShadow: "var(--shadow)",
        marginBottom: 20,
      }}
    >
      {header && (
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
          {header}
        </div>
      )}
      <div style={{ padding: "20px" }}>{children}</div>
      {footer && (
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", background: "var(--bg-2)" }}>
          {footer}
        </div>
      )}
    </div>
  );
}

// 11. Header
export function Header({ children, description, actions, variant }: any) {
  const isH1 = variant === "h1";
  const size = isH1 ? "22px" : "16px";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: size, fontWeight: 800, letterSpacing: "-0.02em" }}>{children}</h2>
        {description && <div style={{ fontSize: "12px", color: "var(--text-3)", marginTop: 4 }}>{description}</div>}
      </div>
      {actions && <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{actions}</div>}
    </div>
  );
}

// 12. FormField
export function FormField({ children, label, description, constraintText, errorText }: any) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16, width: "100%" }}>
      {label && <label style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-2)" }}>{label}</label>}
      {description && <span style={{ fontSize: "11.5px", color: "var(--text-3)" }}>{description}</span>}
      <div style={{ width: "100%" }}>{children}</div>
      {constraintText && !errorText && <span style={{ fontSize: "11px", color: "var(--text-4)" }}>{constraintText}</span>}
      {errorText && <span style={{ fontSize: "11px", color: "var(--down)", fontWeight: 500 }}>{errorText}</span>}
    </div>
  );
}

// 13. SpaceBetween
export function SpaceBetween({ children, size, direction, alignItems }: any) {
  const gap = size === "l" ? "20px" : size === "m" ? "12px" : "8px";
  const dir = direction === "horizontal" ? "row" : "column";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: dir,
        gap,
        alignItems: alignItems || (direction === "horizontal" ? "center" : "stretch"),
        width: direction === "horizontal" ? undefined : "100%",
      }}
    >
      {children}
    </div>
  );
}

// 14. ColumnLayout
export function ColumnLayout({ children, columns, variant }: any) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns || 3}, minmax(0, 1fr))`,
        gap: "20px",
        width: "100%",
      }}
    >
      {children}
    </div>
  );
}

// 15. Grid
export function Grid({ children, gridDefinition }: any) {
  // Simplification mapping columns definitions
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
        gap: "18px",
        width: "100%",
      }}
    >
      {React.Children.map(children, (child, idx) => {
        const span = gridDefinition?.[idx]?.colspan || 12;
        return <div style={{ gridColumn: `span ${span}` }}>{child}</div>;
      })}
    </div>
  );
}

// 16. KeyValuePairs
export function KeyValuePairs({ items, columns }: any) {
  const cols = columns || 3;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gap: "16px",
        marginBottom: 16,
      }}
    >
      {items.map((item: any, i: number) => (
        <div key={i}>
          <div className="eyebrow" style={{ fontSize: "9.5px", marginBottom: 4 }}>{item.label}</div>
          <div className="mono" style={{ fontSize: "13px", color: "var(--text-2)" }}>{item.value || "—"}</div>
        </div>
      ))}
    </div>
  );
}

// 17. Alert
export function Alert({ children, type, dismissible, onDismiss, header }: any) {
  const color = type === "error" ? "var(--down)" : type === "success" ? "var(--ok)" : type === "warning" ? "var(--afk)" : "var(--active)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "12px 16px",
        borderRadius: "var(--r)",
        border: `1px solid ${color}40`,
        background: `${color}0b`,
        color: "var(--text)",
        marginBottom: 14,
      }}
    >
      <AlertCircle size={16} style={{ color, flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1 }}>
        {header && <div style={{ fontWeight: 700, fontSize: "13px", marginBottom: 2 }}>{header}</div>}
        <div style={{ fontSize: "12.5px", color: "var(--text-2)" }}>{children}</div>
      </div>
      {dismissible && (
        <button
          type="button"
          onClick={onDismiss}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", padding: 0 }}
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}

// 18. Table
export function Table({ items, columnDefinitions, loading, loadingText, empty, variant, selectionType, selectedItems, onSelectionChange }: any) {
  return (
    <div
      style={{
        borderRadius: variant === "embedded" ? "0" : "var(--r-lg)",
        border: variant === "embedded" ? "none" : "1px solid var(--border)",
        background: variant === "embedded" ? "transparent" : "var(--surface)",
        overflow: "hidden",
        boxShadow: variant === "embedded" ? "none" : "var(--shadow)",
        width: "100%",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "var(--bg-2)" }}>
            {selectionType === "multi" && (
              <th style={{ width: 40, padding: "10px 16px", borderBottom: "1px solid var(--border-2)" }}>
                <input
                  type="checkbox"
                  checked={items.length > 0 && selectedItems?.length === items.length}
                  onChange={(e) => {
                    if (e.target.checked) {
                      onSelectionChange?.({ detail: { selectedItems: [...items] } });
                    } else {
                      onSelectionChange?.({ detail: { selectedItems: [] } });
                    }
                  }}
                />
              </th>
            )}
            {columnDefinitions.map((col: any) => (
              <th
                key={col.id}
                style={{
                  width: col.width,
                  textAlign: "left",
                  padding: "10px 16px",
                  borderBottom: "1px solid var(--border-2)",
                }}
              >
                <div className="eyebrow" style={{ fontSize: "10px", color: "var(--text-3)" }}>
                  {col.header}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columnDefinitions.length + (selectionType === "multi" ? 1 : 0)} style={{ textAlign: "center", padding: "30px" }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                  <Spinner size="large" />
                  <span style={{ fontSize: "12px", color: "var(--text-3)" }}>{loadingText || "Loading..."}</span>
                </div>
              </td>
            </tr>
          ) : items.length === 0 ? (
            <tr>
              <td colSpan={columnDefinitions.length + (selectionType === "multi" ? 1 : 0)} style={{ textAlign: "center", padding: "30px", color: "var(--text-3)" }}>
                {empty || "No items"}
              </td>
            </tr>
          ) : (
            items.map((item: any, idx: number) => {
              const isSelected = selectedItems?.some((si: any) => si.id === item.id);
              return (
                <tr
                  key={item.id || idx}
                  style={{
                    borderBottom: "1px solid var(--border)",
                    background: isSelected ? "var(--accent-soft)" : "transparent",
                  }}
                >
                  {selectionType === "multi" && (
                    <td style={{ padding: "10px 16px" }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => {
                          const nextSelected = e.target.checked
                            ? [...(selectedItems || []), item]
                            : (selectedItems || []).filter((si: any) => si.id !== item.id);
                          onSelectionChange?.({ detail: { selectedItems: nextSelected } });
                        }}
                      />
                    </td>
                  )}
                  {columnDefinitions.map((col: any) => (
                    <td key={col.id} style={{ padding: "12px 16px", fontSize: "13px", color: "var(--text-2)" }}>
                      {col.cell(item)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// 19. Modal
export function Modal({ children, visible, onDismiss, header, footer }: any) {
  if (!visible) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(11, 12, 15, 0.75)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        padding: 20,
      }}
    >
      <div
        className="scroller"
        style={{
          width: "100%",
          maxWidth: "560px",
          background: "var(--surface)",
          border: "1px solid var(--border-2)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--shadow)",
          display: "flex",
          flexDirection: "column",
          maxHeight: "90vh",
        }}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "16px", fontWeight: 800, letterSpacing: "-0.01em" }}>{header}</span>
          <button type="button" onClick={onDismiss} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)" }}>
            <X size={16} />
          </button>
        </div>
        <div className="scroller" style={{ padding: "20px", overflowY: "auto", flex: 1 }}>{children}</div>
        {footer && (
          <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", background: "var(--bg-2)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// 20. Link
export function Link({ children, href, external, variant, onClick }: any) {
  return (
    <a
      href={href}
      onClick={onClick}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      style={{
        color: "var(--accent)",
        textDecoration: "none",
        fontSize: "13px",
        fontWeight: 500,
        cursor: "pointer",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
      onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
    >
      {children}
    </a>
  );
}

// 21. Popover
export function Popover({ content, trigger, position }: any) {
  // Simple layout mapping
  return (
    <div style={{ display: "inline-block", position: "relative" }}>
      {trigger}
    </div>
  );
}

// 22. Form
export function Form({ children, actions, header }: any) {
  return (
    <form style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {header && <div style={{ marginBottom: 12 }}>{header}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>
      {actions && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          {actions}
        </div>
      )}
    </form>
  );
}

// 23. SegmentedControl
export function SegmentedControl({ selectedId, onChange, options }: any) {
  return (
    <div className="seg">
      {options.map((opt: any) => {
        const isSelected = opt.id === selectedId;
        return (
          <button
            key={opt.id}
            type="button"
            className={isSelected ? "on" : ""}
            onClick={() => onChange?.({ detail: { selectedId: opt.id } })}
          >
            {opt.text}
          </button>
        );
      })}
    </div>
  );
}

// 24. TextFilter
export function TextFilter({ filteringText, onChange, filteringPlaceholder, countText }: any) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
      <Input
        value={filteringText}
        placeholder={filteringPlaceholder}
        onChange={({ detail }: any) => onChange?.({ detail: { filteringText: detail.value } })}
      />
      {countText && <span style={{ fontSize: "11px", color: "var(--text-3)" }}>{countText}</span>}
    </div>
  );
}

// 25. ButtonDropdown
export function ButtonDropdown({ children, items, onItemClick }: any) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const clickAway = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", clickAway);
    return () => document.removeEventListener("mousedown", clickAway);
  }, []);

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block", width: "100%" }}>
      <button
        type="button"
        className="field"
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
        }}
      >
        <span>{children}</span>
        <ChevronDown size={14} style={{ color: "var(--text-3)" }} />
      </button>

      {open && (
        <div
          className="scroller"
          style={{
            position: "absolute",
            top: "105%",
            left: 0,
            width: "100%",
            background: "var(--surface-2)",
            border: "1px solid var(--border-3)",
            borderRadius: "var(--r-sm)",
            zIndex: 1000,
            maxHeight: "200px",
            overflowY: "auto",
            boxShadow: "var(--shadow)",
          }}
        >
          {items.map((item: any) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onItemClick?.({ detail: { id: item.id } });
                setOpen(false);
              }}
              style={{
                width: "100%",
                textAlign: "left",
                background: "transparent",
                color: "var(--text-2)",
                border: "none",
                padding: "8px 12px",
                cursor: "pointer",
                fontSize: "13px",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-3)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {item.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 26. Badge
export function Badge({ children, color }: any) {
  const bg = color === "blue" ? "var(--accent-soft)" : "var(--border-3)";
  const tc = color === "blue" ? "var(--accent)" : "var(--text-2)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: "99px",
        fontSize: "11px",
        fontWeight: 600,
        background: bg,
        color: tc,
      }}
    >
      {children}
    </span>
  );
}
