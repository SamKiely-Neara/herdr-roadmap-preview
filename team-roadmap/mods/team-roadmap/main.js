// Derived from roadmap-preview by Nikospy (MIT, see LICENSE).
//
// team-roadmap: a team's roadmap.json as milestone lanes and task cards in its workspace tab.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { props, theme, nextCommand, checking, terminals } from "herdr";
import { snapshot, watch } from "./source.js";
import { liveByName, relatedTo, toView } from "./model.js";
import { layout } from "./layout.js";

const MOD = "team-roadmap";
const AXIS = 24, HEAD = 32, TOP = 96, LANE_GAP = 48;
const CARD_W = 220, CARD_H = 88, CARD_H_TALL = 120, PORT_Y = 36;
const COL_STEP = 272, ROW_STEP = 152;
const BIG = 16, MID = 13, SMALL = 11;
const KMIN = 0.3, KMAX = 3;

const KIND_LABELS = {
  done: "DONE",
  active: "IN PROGRESS",
  partial: "PARTIAL",
  blocked: "BLOCKED",
  ready: "READY",
  waiting: "WAITING",
  parked: "PARKED",
};

/** "k/n" checklist progress, or "" when the task has no steps. */
const stepsText = (task) => (task.steps.length ? `${task.steps.filter((s) => s.done).length}/${task.steps.length}` : "");

export default class TeamRoadmap extends View {
  init(p, cx) {
    this.src = {
      team: props()?.team ?? p?.team ?? null,
      machine: props()?.machine ?? p?.machine ?? null,
    };
    this.snap = null;        // last raw snapshot
    this.token = null;       // last snapshot token
    this.error = null;       // last fetch error string
    this.member = null;      // selected member name, or null
    this.task = null;        // selected task id, or null
    this.tab = "team";       // "team" | "task"
    this.loading = Boolean(this.src.team);
    this.busy = false;
    this.dirty = false;
    this.cancel = null;

    // The map's own viewport: zoom k, offset (ox, oy) in zoomed px, the view's size.
    this.k = 1; this.ox = 0; this.oy = 0; this.viewport = null; this.fitted = false;
    this.drag = null; this.moved = false;
    this.keys = cx.focus_handle();
    this.keys.focus();
    cx.timer.after(600, () => this.keys.focus());

    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        if (c.startsWith("zoom:")) this.zoomCommand(c.slice(5));
        cx.notify();
      }
    });

    if (!this.src.team || checking()) return;
    this.refresh(cx);
    this.cancel = watch(this.src, cx, (cx) => this.refresh(cx));
  }

  async close() {
    this.cancel?.();
    this.cancel = null;
  }

  refresh(cx) {
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        const s = await snapshot(this.src, this.token);
        if (!s.unchanged) {
          this.snap = s;
          this.token = s.token;
        }
        changed = !s.unchanged || this.error !== null || this.loading;
        this.error = null;
      } catch (err) {
        const msg = String(err?.message ?? err);
        changed = this.error !== msg || this.loading;
        this.error = msg;
      } finally {
        this.loading = false;
        this.busy = false;
        if (changed) cx.notify();
        if (this.dirty) {
          this.dirty = false;
          this.refresh(cx);
        }
      }
    });
  }

  // ---- viewport ------------------------------------------------------------------------------

  z(n) { return n * this.k; }

  clamp() {
    const v = this.viewport, s = this.size;
    if (!v || !s) return;
    const w = s.w * this.k, h = s.h * this.k;
    this.ox = w <= v.width ? -(v.width - w) / 2 : Math.min(Math.max(this.ox, 0), w - v.width);
    this.oy = h <= v.height ? -(v.height - h) / 2 : Math.min(Math.max(this.oy, 0), h - v.height);
  }

  zoomTo(k, at) {
    const v = this.viewport;
    const px = at?.x ?? (v ? v.width / 2 : 0), py = at?.y ?? (v ? v.height / 2 : 0);
    const wx = (this.ox + px) / this.k, wy = (this.oy + py) / this.k;
    this.k = Math.min(KMAX, Math.max(KMIN, k));
    this.ox = wx * this.k - px; this.oy = wy * this.k - py;
    this.clamp();
  }

  fit() {
    const v = this.viewport, s = this.size;
    if (!v || !s) return;
    this.k = Math.min(1, Math.max(0.8, v.height / s.h));
    this.oy = 0;
    this.ox = s.w * this.k > v.width ? Math.max(0, (this.focusX ?? 0) - AXIS) * this.k : 0;
    this.clamp();
    this.fitted = true;
  }

  zoomCommand(what) {
    if (what === "in") this.zoomTo(this.k * 1.25);
    else if (what === "out") this.zoomTo(this.k / 1.25);
    else if (what === "fit") this.fit();
    else if (what === "1" || what === "100") this.zoomTo(1);
  }

  key(e, cx) {
    const k = e.key, step = 96;
    if (k === "+" || k === "=") this.zoomCommand("in");
    else if (k === "-" || k === "_") this.zoomCommand("out");
    else if (k === "0") this.zoomCommand("fit");
    else if (k === "1") this.zoomCommand("1");
    else if (k === "left") this.ox -= step;
    else if (k === "right") this.ox += step;
    else if (k === "up") this.oy -= step;
    else if (k === "down") this.oy += step;
    else return;
    this.clamp();
    cx.stop_propagation();
    cx.notify();
  }

  // ---- helpers -------------------------------------------------------------------------------

  shortOf(memberName, shorts) {
    if (!memberName) return "";
    return shorts.get(memberName) ?? memberName;
  }

  ownerText(it, shorts) {
    if (!it.people.length) return "";
    return it.people.map((name) => this.shortOf(name, shorts)).join(" → ");
  }

  kindColor(kind, t, c) {
    if (kind === "done") return c.done;
    if (kind === "active") return c.active;
    if (kind === "partial") return c.partial;
    if (kind === "blocked") return c.blocked;
    if (kind === "ready") return t.foreground;
    return t.muted;
  }

  laneColor(state, t, c) {
    if (state === "done") return c.done;
    if (state === "active") return c.active;
    return t.muted;
  }

  cardHeight(it) {
    return it.kind === "blocked" || it.steps.length > 0 ? CARD_H_TALL : CARD_H;
  }

  selectTask(id) {
    this.task = id;
    this.tab = "task";
  }

  // ---- map drawing ---------------------------------------------------------------------------

  taskCardEl(it, t, c, shorts, dimmed = false, selected = false) {
    const z = (n) => this.z(n);
    const kc = this.kindColor(it.kind, t, c);
    const h = this.cardHeight(it);
    const strong = it.kind === "ready" || it.kind === "active" || it.kind === "blocked";

    const owners = this.ownerText(it, shorts);
    const ownerPart = !it.assignee && it.queue
      ? (owners ? `${owners} → ${it.queue} queue` : `→ ${it.queue} queue`)
      : owners;
    const metaParts = [];
    if (ownerPart) metaParts.push(ownerPart);
    if (it.kind === "waiting" && it.waits.length) metaParts.push(`waits on ${it.waits.join(", ")}`);
    const sc = stepsText(it);
    if (sc) metaParts.push(sc);
    const meta = metaParts.join(" · ");

    return v_flex()
      .id(`rm-c-${it.id}`)
      .absolute()
      .left(z(it.x))
      .top(z(it.y))
      .w(z(CARD_W))
      .h(z(h))
      .px(z(10))
      .py(z(8))
      .gap(z(4))
      .rounded(z(6))
      .bg(t.surface)
      .border(selected ? 2 : 1)
      .border_color(selected ? t.accent : kc)
      .overflow_hidden()
      .cursor_pointer()
      .when(dimmed, (el) => el.opacity(0.25))
      .on_click((_e, cx) => {
        if (this.moved) return;
        if (this.task === it.id && this.tab === "task") {
          this.task = null;
          this.tab = "team";
        } else {
          this.selectTask(it.id);
        }
        cx.notify();
      })
      .child(
        h_flex()
          .gap(z(6))
          .items_center()
          .line_height(`${z(14)}px`)
          .child(
            div()
              .flex_1()
              .truncate()
              .text_size(z(SMALL))
              .font_semibold()
              .text_color(kc)
              .child(KIND_LABELS[it.kind] ?? it.status.toUpperCase()),
          )
          .child(div().flex_none().text_size(z(SMALL)).font_semibold().text_color(t.muted).child(it.id)),
      )
      .child(
        div()
          .flex_none()
          .max_h(z(34))
          .overflow_hidden()
          .text_size(z(MID))
          .line_height(`${z(17)}px`)
          .text_color(strong ? t.foreground : t.muted)
          .child(it.title),
      )
      .when(Boolean(meta), (el) =>
        el.child(div().truncate().text_size(z(SMALL)).line_height(`${z(14)}px`).text_color(t.muted).child(meta)),
      )
      .when(Boolean(it.kind === "blocked" && it.blocker?.reason), (el) =>
        el.child(
          div()
            .max_h(z(28))
            .overflow_hidden()
            .text_size(z(SMALL))
            .line_height(`${z(14)}px`)
            .text_color(c.blocked)
            .child(`⚠ ${it.blocker.reason}`),
        ),
      );
  }

  edgeEls(edge, a, b, t, c, lane = 0, dimmed = false) {
    const z = (n) => this.z(n);
    const met = edge.met;
    const color = met ? t.muted : this.kindColor(edge.fromKind, t, c);
    const thick = 2;
    const hl = (x, y, w) =>
      div()
        .absolute()
        .left(z(x))
        .top(z(y) - thick / 2)
        .w(z(w))
        .h(0)
        .border_t(thick)
        .border_color(color)
        .when(!met, (el) => el.border_dashed())
        .when(dimmed, (el) => el.opacity(0.25));
    const vl = (x, y1, y2) =>
      div()
        .absolute()
        .left(z(x) - thick / 2)
        .top(z(Math.min(y1, y2)))
        .w(0)
        .h(z(Math.abs(y2 - y1)))
        .border_l(thick)
        .border_color(color)
        .when(!met, (el) => el.border_dashed())
        .when(dimmed, (el) => el.opacity(0.25));
    const arrow = div()
      .absolute()
      .left(z(b.x) - z(4))
      .top(z(b.y + PORT_Y) - z(2))
      .size(z(4))
      .bg(color)
      .when(dimmed, (el) => el.opacity(0.25));

    const sx = a.x + CARD_W;
    const sy = a.y + PORT_Y;
    const tx = b.x;
    const ty = b.y + PORT_Y;

    if (tx > sx) {
      if (sy === ty) return [hl(sx, sy, tx - sx), arrow];
      const xm = Math.min(tx - 14, sx + 16 + 6 * (lane % 4));
      return [hl(sx, sy, xm - sx), vl(xm, sy, ty), hl(xm, ty, tx - xm), arrow];
    }

    // Same column or backward edge: route through the horizontal gutter between rows.
    const xOut = sx + 14;
    const xIn = tx - 14;
    const yGutter = Math.min(a.y, b.y) + CARD_H_TALL + 16 + 4 * (lane % 3);
    return [
      hl(sx, sy, xOut - sx),
      vl(xOut, sy, yGutter),
      hl(Math.min(xOut, xIn), yGutter, Math.abs(xOut - xIn)),
      vl(xIn, yGutter, ty),
      hl(xIn, ty, tx - xIn),
      arrow,
    ];
  }

  // ---- sidebar -------------------------------------------------------------------------------

  section(title, t) {
    return div().text_size(SMALL).font_semibold().text_color(t.muted).child(title);
  }

  livePillColor(live, t, c) {
    if (live === "working") return c.active;
    if (live === "blocked") return c.blocked;
    if (live === "idle") return t.muted;
    return t.dim;
  }

  teamQueuesBody(view, taskById, shorts, t, c, stop) {
    const liveMembers = view.members.filter((m) => m.role !== "former");
    const formerMembers = view.members.filter((m) => m.role === "former");
    const memberBlock = (m) => {
      const selected = this.member === m.name;
      const pillColor = this.livePillColor(m.live, t, c);
      const primary = m.doing[0] ? taskById.get(m.doing[0]) : null;
      const otherOpen = m.open.filter((id) => id !== m.doing[0]).map((id) => taskById.get(id)).filter(Boolean);
      return v_flex()
        .gap(3)
        .px(8)
        .py(6)
        .rounded(4)
        .when(selected, (el) => el.bg(t.selected))
        .child(
          h_flex()
            .id(`rm-m-${m.name}`)
            .gap(8)
            .items_center()
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_mouse_down("left", stop)
            .on_click((_e, cx) => {
              this.member = selected ? null : m.name;
              cx.notify();
            })
            .child(div().flex_1().truncate().font_semibold().child(`${m.short} · ${m.preset ?? m.role}`))
            .child(
              div()
                .flex_none()
                .text_size(SMALL)
                .font_semibold()
                .text_color(pillColor)
                .child(m.live.toUpperCase()),
            ),
        )
        .when(Boolean(primary), (el) =>
          el.child(
            h_flex()
              .id(`rm-mp-${m.name}-${primary.id}`)
              .pl(8)
              .gap(6)
              .items_center()
              .cursor_pointer()
              .rounded(4)
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                this.selectTask(primary.id);
                cx.notify();
              })
              .child(
                div()
                  .flex_1()
                  .truncate()
                  .text_size(SMALL)
                  .text_color(t.foreground)
                  .child(`→ ${primary.id} ${primary.title}${stepsText(primary) ? ` ${stepsText(primary)}` : ""}`),
              ),
          ),
        )
        .when(!primary && m.drift, (el) =>
          el.child(
            div()
              .pl(8)
              .text_size(SMALL)
              .text_color(c.partial)
              .child("working · no task on roadmap"),
          ),
        )
        .when(!primary && !m.drift, (el) =>
          el.child(div().pl(8).text_size(SMALL).text_color(t.dim).child(m.live === "offline" ? "offline" : "idle")),
        )
        .when(otherOpen.length > 0, (el) =>
          el.child(
            h_flex()
              .pl(8)
              .flex_wrap()
              .gap(6)
              .items_center()
              .child(div().text_size(SMALL).text_color(t.muted).child("also:"))
              .children(
                otherOpen.map((ot) =>
                  div()
                    .id(`rm-ma-${m.name}-${ot.id}`)
                    .px(4)
                    .py(1)
                    .rounded(3)
                    .bg(t.chrome)
                    .cursor_pointer()
                    .text_size(SMALL)
                    .text_color(this.kindColor(ot.kind, t, c))
                    .hover((s) => s.bg(t.hover))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => {
                      this.selectTask(ot.id);
                      cx.notify();
                    })
                    .child(`${ot.id} (${ot.status})`),
                ),
              ),
          ),
        );
    };


    return v_flex()
      .gap(12)
      .child(v_flex().gap(4).children(liveMembers.map(memberBlock)))
      .when(formerMembers.length > 0, (el) =>
        el.child(
          v_flex()
            .gap(4)
            .child(this.section("Former", t))
            .children(
              formerMembers.map((m) =>
                h_flex()
                  .id(`rm-m-${m.name}`)
                  .px(8)
                  .py(4)
                  .rounded(4)
                  .cursor_pointer()
                  .when(this.member === m.name, (row) => row.bg(t.selected))
                  .hover((s) => s.bg(t.hover))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => {
                    this.member = this.member === m.name ? null : m.name;
                    cx.notify();
                  })
                  .child(div().text_size(SMALL).text_color(t.dim).child(m.short)),
              ),
            ),
        ),
      )
      .child(
        v_flex()
          .gap(8)
          .pt(8)
          .border_t(1)
          .border_color(t.border)
          .child(this.section("Queues", t))
          .children(
            view.queues.map((q) =>
              v_flex()
                .gap(3)
                .child(
                  div()
                    .text_size(SMALL)
                    .font_semibold()
                    .text_color(t.muted)
                    .child(`${q.preset} (${q.tasks.length})`),
                )
                .children(
                  q.tasks.length
                    ? q.tasks.map((it) => {
                        const badge = it.kind === "waiting" ? `WAITING (${it.waits.join(", ")})` : KIND_LABELS[it.kind];
                        return h_flex()
                          .id(`rm-q-${it.id}`)
                          .pl(8)
                          .pr(4)
                          .py(3)
                          .gap(6)
                          .rounded(4)
                          .items_center()
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_mouse_down("left", stop)
                          .on_click((_e, cx) => {
                            this.selectTask(it.id);
                            cx.notify();
                          })
                          .child(
                            div()
                              .flex_none()
                              .text_size(SMALL)
                              .font_semibold()
                              .text_color(this.kindColor(it.kind, t, c))
                              .child(badge),
                          )
                          .child(div().flex_none().text_size(SMALL).text_color(t.muted).child(it.id))
                          .child(div().flex_1().min_w(0).truncate().text_size(SMALL).child(it.title));
                      })
                    : [div().pl(8).text_size(SMALL).text_color(t.dim).child("empty")],
                ),
            ),
          ),
      );
  }

  taskDetailBody(task, view, taskById, shorts, roleByName, t, c, stop) {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const fmt = (iso) => {
      const date = iso.slice(0, 10), hhmm = iso.slice(11, 16);
      return date === today ? hhmm : `${date} ${hhmm}`;
    };
    const kc = this.kindColor(task.kind, t, c);
    const pill = h_flex()
      .self_start()
      .relative()
      .px(8)
      .py(2)
      .rounded(4)
      .items_center()
      .child(div().absolute().left(0).top(0).size_full().rounded(4).bg(kc).opacity(0.18))
      .child(div().relative().text_size(SMALL).font_semibold().text_color(kc).child(KIND_LABELS[task.kind] ?? task.status));
    const touchedEls = [];
    task.touched.forEach((name, idx) => {
      const short = this.shortOf(name, shorts);
      const former = (roleByName.get(name) ?? "former") === "former";
      if (idx > 0) touchedEls.push(div().text_size(SMALL).text_color(t.muted).child(", "));
      touchedEls.push(div().text_size(SMALL).text_color(former ? t.dim : t.foreground).child(short));
    });
    return v_flex()
      .gap(12)
      .child(
        v_flex()
          .gap(4)
          .child(div().text_size(SMALL).font_semibold().text_color(t.muted).child(task.id))
          .child(div().text_size(BIG).font_semibold().child(task.title)),
      )
      .child(
        v_flex()
          .gap(4)
          .child(pill)
          .when(Boolean(task.queue), (el) =>
            el.child(div().text_size(SMALL).text_color(t.muted).child(`Queue: ${task.queue}`)),
          ),
      )
      .child(
        v_flex()
          .gap(4)
          .child(this.section("Assignments", t))
          .children(
            task.assignments.length
              ? task.assignments.map((a) =>
                  div()
                    .text_size(SMALL)
                    .text_color(t.foreground)
                    .child(`${this.shortOf(a.member, shorts)}  ${a.to ? `${fmt(a.from)} → ${fmt(a.to)}` : `since ${fmt(a.from)}`}`),
                )
              : [div().text_size(SMALL).text_color(t.dim).child("None")],
          ),
      )
      .child(
        v_flex()
          .gap(4)
          .child(this.section("Touched by", t))
          .child(touchedEls.length ? h_flex().flex_wrap().children(touchedEls) : div().text_size(SMALL).text_color(t.dim).child("None")),
      )
      .child(
        v_flex()
          .gap(4)
          .child(this.section("Log", t))
          .children(
            task.log.map((e) =>
              div().text_size(SMALL).text_color(t.muted).child(`${fmt(e.at)}  ${this.shortOf(e.by, shorts)}  ${e.change}`),
            ),
          ),
      )
      .child(
        v_flex()
          .gap(4)
          .child(this.section("Brief", t))
          .child(task.brief ? TextView.markdown(`rm-brief-${task.id}`, task.brief) : div().text_size(SMALL).text_color(t.dim).child("No brief")),
      );
  }

  sidePane(view, taskById, shorts, roleByName, t, c, stop) {
    const selectedTask = this.task ? taskById.get(this.task) ?? null : null;
    const showTask = this.tab === "task" && selectedTask !== null;
    const tabBtn = (id, label, active, onClick) =>
      h_flex()
        .id(id)
        .px(10)
        .py(5)
        .rounded(4)
        .cursor_pointer()
        .text_size(SMALL)
        .font_semibold()
        .when(active, (el) => el.bg(t.selected).text_color(t.foreground))
        .when(!active, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          onClick();
          cx.notify();
        })
        .child(label);

    return v_flex()
      .w(340)
      .h_full()
      .flex_none()
      .border_l(1)
      .border_color(t.border)
      .bg(t.surface)
      .child(
        h_flex()
          .flex_none()
          .px(12)
          .py(8)
          .gap(6)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(tabBtn("rm-tab-team", "Team & Queues", !showTask, () => { this.tab = "team"; }))
          .when(Boolean(selectedTask), (el) =>
            el.child(
              h_flex()
                .gap(4)
                .items_center()
                .child(tabBtn("rm-tab-task", `Task ${selectedTask.id}`, showTask, () => { this.tab = "task"; }))
                .child(
                  h_flex()
                    .id("rm-tab-task-close")
                    .size(20)
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .cursor_pointer()
                    .text_size(SMALL)
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => {
                      this.task = null;
                      this.tab = "team";
                      cx.notify();
                    })
                    .child("×"),
                ),
            ),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(14)
          .child(
            showTask
              ? this.taskDetailBody(selectedTask, view, taskById, shorts, roleByName, t, c, stop)
              : this.teamQueuesBody(view, taskById, shorts, t, c, stop),
          ),
      );
  }

  render(cx) {
    const t = theme();
    const c = { done: t.ansi2, active: t.ansi4, partial: t.ansi3, blocked: t.ansi1, quiet: t.dim };
    const stop = (_e, cx) => cx.stop_propagation();

    const frame = (header, ...rest) =>
      v_flex()
        .id(MOD)
        .size_full()
        .min_h(0)
        .overflow_hidden()
        .track_focus(this.keys)
        .on_key_down((e, cx) => this.key(e, cx))
        .bg(t.background)
        .text_color(t.foreground)
        .text_size(MID)
        .child(header)
        .children(rest);
    const bar = (...kids) =>
      h_flex().h(HEAD).flex_none().px(AXIS).gap(14).items_center().bg(t.chrome).children(kids.filter(Boolean));
    const message = (title, text) =>
      frame(
        bar(div().flex_1().text_color(t.muted).child("Team roadmap")),
        v_flex()
          .flex_1()
          .p(AXIS)
          .gap(8)
          .child(div().text_size(BIG).font_semibold().child(title))
          .child(div().max_w(560).text_color(t.muted).line_height("20px").child(text)),
      );

    if (!this.src.team) {
      return message(
        "No team given",
        "Open it with: team-roadmap open-tab <team> (on the machine the team runs on)",
      );
    }
    if (this.loading) return message("Loading the roadmap…", "");
    if (!this.snap) return message("Can't read the roadmap", this.error ?? "");

    let view;
    try {
      const live = liveByName(checking() ? [] : terminals(), this.src.machine);
      view = toView(this.snap, live);
    } catch (err) {
      return message("Can't read the roadmap", String(err?.message ?? err));
    }

    const shorts = new Map(view.members.map((m) => [m.name, m.short]));
    const doneCount = view.tasks.filter((i) => i.status === "done").length;
    const activeCount = view.tasks.filter((i) => i.kind === "active").length;
    const blockedCount = view.tasks.filter((i) => i.kind === "blocked").length;
    const readyCount = view.tasks.filter((i) => i.kind === "ready").length;

    const btn = (id, label, fn) =>
      h_flex()
        .id(id)
        .h(22)
        .px(8)
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(4)
        .cursor_pointer()
        .text_size(SMALL)
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          fn();
          cx.notify();
        })
        .child(label);
    const zoom = h_flex()
      .flex_none()
      .gap(2)
      .items_center()
      .child(btn("rm-zoom-out", "−", () => this.zoomCommand("out")))
      .child(btn("rm-zoom-100", `${Math.round(this.k * 100)}%`, () => this.zoomCommand("1")))
      .child(btn("rm-zoom-in", "+", () => this.zoomCommand("in")))
      .child(btn("rm-zoom-fit", "Fit", () => this.zoomCommand("fit")));

    const counts = `${activeCount} in progress · ${blockedCount} blocked · ${readyCount} ready · ${doneCount} of ${view.tasks.length} done`;
    const header = bar(
      div().flex_none().font_semibold().child(view.team),
      div().flex_none().text_size(SMALL).text_color(t.dim).child(this.src.machine ?? "this Mac"),
      div().flex_1().min_w(0).truncate().text_size(SMALL).text_color(t.muted).child(counts),
      this.error ? div().flex_none().max_w(280).truncate().text_size(SMALL).text_color(c.blocked).child(this.error) : null,
      zoom,
    );

    const taskById = new Map(view.tasks.map((it) => [it.id, it]));
    const roleByName = new Map(view.members.map((m) => [m.name, m.role]));
    const lit = this.member ? relatedTo(view, this.member) : null;
    const isDim = (id) => Boolean(lit && !lit.has(id));

    // Geometry first, unzoomed: each milestone lane's width and each task's place.
    let x = AXIS, rows = 1;
    const lanes = view.milestones.map((m) => ({ ...m, x: 0, w: 0 }));
    for (const lane of lanes) {
      lane.x = x;
      const g = layout(lane.tasks, view.tasks);
      rows = Math.max(rows, g.rows);
      for (const it of lane.tasks) {
        it.x = lane.x + it.d * COL_STEP;
        it.y = TOP + it.r * ROW_STEP;
      }
      lane.w = Math.max(1, g.cols) * COL_STEP - (COL_STEP - CARD_W);
      x += lane.w + LANE_GAP;
    }
    const W = Math.max(x + 24, 480);
    const H = TOP + (rows - 1) * ROW_STEP + CARD_H_TALL + 48;
    this.size = { w: W, h: H + 32 };
    this.focusX = lanes[0]?.x ?? 0;
    if (!this.fitted && this.viewport) this.fit();

    const z = (n) => this.z(n);
    const els = [];
    for (const lane of lanes) {
      const lc = this.laneColor(lane.state, t, c);
      const frac = lane.total ? lane.done / lane.total : 0;
      const headW = Math.max(lane.w, CARD_W);
      els.push(
        v_flex()
          .absolute()
          .left(z(lane.x))
          .top(0)
          .w(z(headW))
          .gap(z(4))
          .child(
            h_flex()
              .gap(z(8))
              .items_center()
              .child(div().flex_1().truncate().text_size(z(MID)).font_semibold().text_color(t.foreground).child(lane.title))
              .child(div().flex_none().text_size(z(SMALL)).font_semibold().text_color(lc).child(lane.state.toUpperCase())),
          )
          .when(Boolean(lane.goal), (el) =>
            el.child(div().truncate().text_size(z(SMALL)).text_color(t.muted).child(lane.goal)),
          )
          .child(
            h_flex()
              .gap(z(8))
              .items_center()
              .child(div().flex_none().text_size(z(SMALL)).text_color(t.muted).child(`${lane.done}/${lane.total} done`))
              .child(
                div()
                  .flex_1()
                  .h(z(4))
                  .rounded(z(2))
                  .bg(t.border)
                  .relative()
                  .overflow_hidden()
                  .when(frac > 0, (el) =>
                    el.child(
                      div()
                        .absolute()
                        .left(0)
                        .top(0)
                        .h_full()
                        .w(z(Math.max(4, Math.round((headW - 72) * frac))))
                        .bg(lane.state === "done" ? c.done : c.active),
                    ),
                  ),
              ),
          ),
      );
    }

    const edgeCounts = new Map();
    for (const edge of view.edges) {
      const a = taskById.get(edge.from);
      const b = taskById.get(edge.to);
      const laneIdx = edgeCounts.get(b.id) ?? 0;
      edgeCounts.set(b.id, laneIdx + 1);
      const dimmed = Boolean(lit && (!lit.has(a.id) || !lit.has(b.id)));
      els.push(...this.edgeEls(edge, a, b, t, c, laneIdx, dimmed));
    }

    for (const it of view.tasks) {
      els.push(this.taskCardEl(it, t, c, shorts, isDim(it.id), this.task === it.id));
    }

    const map = div()
      .id("rm-view")
      .flex_1()
      .min_w(0)
      .min_h(0)
      .h_full()
      .relative()
      .overflow_hidden()
      .cursor_grab()
      .on_size_change((size, cx) => {
        this.viewport = size;
        if (!this.fitted) this.fit();
        else this.clamp();
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => {
        if (e.modifiers.platform || e.modifiers.control) {
          const dy = e.delta_lines ? e.delta_lines.y * 40 : e.delta.y;
          this.zoomTo(this.k * Math.exp(dy / 300), e.local_position);
        } else {
          this.ox -= e.delta.x;
          this.oy -= e.delta.y;
          this.clamp();
        }
        cx.notify();
      })
      .on_mouse_down("left", (e) => {
        this.drag = { x: e.position.x, y: e.position.y, ox: this.ox, oy: this.oy };
        this.moved = false;
        this.keys.focus();
      })
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        const dx = e.position.x - this.drag.x, dy = e.position.y - this.drag.y;
        if (!this.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        this.moved = true;
        this.ox = this.drag.ox - dx;
        this.oy = this.drag.oy - dy;
        this.clamp();
        cx.notify();
      })
      .on_mouse_up("left", () => {
        this.drag = null;
      })
      .child(
        div()
          .absolute()
          .left(-this.ox)
          .top(-this.oy)
          .w(z(W))
          .h(z(H + 32))
          .child(div().absolute().left(0).top(z(24)).w(z(W)).h(z(H)).children(els)),
      );

    const body = h_flex()
      .flex_1()
      .min_h(0)
      .child(map)
      .child(this.sidePane(view, taskById, shorts, roleByName, t, c, stop));

    return frame(header, body);
  }
}
