// Derived from roadmap-preview by Nikospy (MIT, see LICENSE).
//
// team-roadmap: a team's roadmap.json as a map in its workspace tab.
// Phases run left to right; a task is a station, a line is a prerequisite.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { props, theme, nextCommand, checking } from "herdr";
import { snapshot, watch } from "./source.js";
import { relatedTo, toView } from "./model.js";
import { layout } from "./layout.js";

const MOD = "team-roadmap";
const AXIS = 24, HEAD = 32, COL = 200, ROW = 104, TOP = 128, LABEL = 176, GAP = 64;
const BIG = 16, MID = 13, SMALL = 11;
const KMIN = 0.3, KMAX = 3;

export default class TeamRoadmap extends View {
  init(p, cx) {
    this.src = {
      team: props()?.team ?? p?.team ?? null,
      machine: props()?.machine ?? p?.machine ?? null,
    };
    this.view = null;        // RoadmapView, last good one
    this.token = null;       // last snapshot token
    this.error = null;       // last fetch error string
    this.member = null;      // selected member name, or null
    this.task = null;        // selected task id, or null
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
          this.view = toView(s);
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
  // The map is drawn at zoom k (every size times k) and moved by (ox, oy): GPUI has no transform.

  z(n) { return n * this.k; }

  // Keeps the map in view; a map smaller than the view sits in its middle.
  clamp() {
    const v = this.viewport, s = this.size;
    if (!v || !s) return;
    const w = s.w * this.k, h = s.h * this.k;
    this.ox = w <= v.width ? -(v.width - w) / 2 : Math.min(Math.max(this.ox, 0), w - v.width);
    this.oy = h <= v.height ? -(v.height - h) / 2 : Math.min(Math.max(this.oy, 0), h - v.height);
  }

  // Zooms around a point of the view (default: its middle), so that point stays put.
  zoomTo(k, at) {
    const v = this.viewport;
    const px = at?.x ?? (v ? v.width / 2 : 0), py = at?.y ?? (v ? v.height / 2 : 0);
    const wx = (this.ox + px) / this.k, wy = (this.oy + py) / this.k;
    this.k = Math.min(KMAX, Math.max(KMIN, k));
    this.ox = wx * this.k - px; this.oy = wy * this.k - py;
    this.clamp();
  }

  // The whole map in view, not smaller than 60 % and not bigger than 160 %.
  fit() {
    const v = this.viewport, s = this.size;
    if (!v || !s) return;
    this.k = Math.min(1.6, Math.max(0.6, Math.min(v.width / s.w, v.height / s.h)));
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

  // ---- drawing (map coordinates are unzoomed; z() zooms them) --------------------------------

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
  // The 360 px card beside the map; beside it, so opening it never moves map coordinates.
  sideCard(t) {
    return v_flex().w(360).flex_none().border_l(1).border_color(t.border).bg(t.surface).overflow_y_scrollbar().p(16).gap(12);
  }

  section(title, t) {
    return div().text_size(SMALL).font_semibold().text_color(t.muted).child(title);
  }

  station(it, t, c, dimmed = false, selected = false) {
    const z = (n) => this.z(n), x = z(it.x), y = z(it.y), r = z(11), dot = z(12);
    const box = () => h_flex().id(`rm-s-${it.id}`).absolute().left(x - r).top(y - r).size(2 * r).rounded(r).bg(t.background)
      .items_center().justify_center().cursor_pointer().when(dimmed, (el) => el.opacity(0.25))
      .on_click((_e, cx) => { if (this.moved) return; this.task = this.task === it.id ? null : it.id; cx.notify(); });
    const round = () => div().size(dot).rounded(dot / 2);
    let mark;
    if (it.kind === "done") mark = box().child(round().bg(c.done));
    else if (it.kind === "active") mark = box().border(2).border_color(c.active).child(round().bg(c.active));
    else if (it.kind === "partial") mark = box().border(2).border_color(c.partial).child(round().bg(c.partial).opacity(0.5));
    else if (it.kind === "blocked") mark = box().child(round().bg(c.blocked));
    else if (it.kind === "ready") mark = box().child(round().border(2).border_color(t.foreground));
    else if (it.kind === "parked") mark = box().child(div().size(dot).rounded(z(2)).border(1).border_color(c.quiet));
    else mark = box().child(round().border(1).border_color(c.quiet));
    if (!selected) return [mark];
    const ring = div().absolute().left(x - r - 4).top(y - r - 4).size(2 * (r + 4)).rounded(r + 4)
      .border(2).border_color(t.accent).when(dimmed, (el) => el.opacity(0.25));
    return [ring, mark];
  }

  label(it, h, t, dimmed = false) {
    const z = (n) => this.z(n), lh = `${z(16)}px`;
    const strong = it.kind === "ready" || it.kind === "active";
    return v_flex().id(`rm-l-${it.id}`).absolute().left(z(it.x - 6)).bottom(z(h - it.y + 14)).w(z(LABEL))
      .cursor_pointer().when(dimmed, (el) => el.opacity(0.25))
      .on_click((_e, cx) => { if (this.moved) return; this.task = this.task === it.id ? null : it.id; cx.notify(); })
      .child(div().text_color(t.muted).text_size(z(SMALL)).font_semibold().line_height(lh).child(it.id))
      .child(div().max_h(z(32)).overflow_hidden().text_size(z(MID)).line_height(lh)
        .text_color(strong ? t.foreground : t.muted).child(it.title));
  }

  under(it, t, c, shorts, dimmed = false) {
    const owners = this.ownerText(it, shorts);
    const queued = !it.assignee && it.queue
      ? (owners ? `${owners} → ${it.queue} queue` : `${it.queue} queue`)
      : null;
    let text = "";
    let color = t.muted;
    if (it.kind === "done") {
      text = owners;
    } else if (it.kind === "active") {
      text = queued ?? (owners || "in progress");
      color = c.active;
    } else if (it.kind === "partial") {
      text = `partial · ${queued ?? (owners || "unassigned")}`;
      color = c.partial;
    } else if (it.kind === "blocked") {
      text = queued ? `blocked · ${queued}` : owners ? `blocked · ${owners}` : "blocked";
      color = c.blocked;
    } else if (it.kind === "waiting") {
      text = `waits for ${it.waits.join(", ")}`;
    } else if (it.kind === "ready") {
      text = queued ?? owners;
    } else if (it.kind === "parked") {
      text = "parked";
    }
    if (!text) return null;
    const z = (n) => this.z(n);
    return div().absolute().left(z(it.x - 6)).top(z(it.y + 12)).w(z(LABEL)).truncate().text_size(z(SMALL)).line_height(`${z(16)}px`)
      .text_color(color).when(dimmed, (el) => el.opacity(0.25)).child(text);
  }

  // A prerequisite: right along the source's row, then down or up, then into the target.
  // `lane` shifts the vertical run, so two links into one column don't share a line.
  link(a, b, t, c, lane = 0, dimmed = false) {
    const z = (n) => this.z(n), met = a.status === "done", color = met ? c.quiet : t.foreground;
    const hl = (x, y, w) => div().absolute().left(z(x)).top(z(y) - 1).w(z(w)).h(0).border_t(met ? 1 : 2).border_color(color)
      .when(!met, (el) => el.border_dashed()).when(dimmed, (el) => el.opacity(0.25));
    const vl = (x, y1, y2) => div().absolute().left(z(x) - 1).top(z(Math.min(y1, y2))).w(0).h(z(Math.abs(y2 - y1))).border_l(met ? 1 : 2).border_color(color)
      .when(!met, (el) => el.border_dashed()).when(dimmed, (el) => el.opacity(0.25));
    if (a.y === b.y) return [hl(a.x, a.y, b.x - a.x)];
    const xm = b.x - 24 - 8 * lane;
    return [hl(a.x, a.y, xm - a.x), vl(xm, a.y, b.y), hl(xm, b.y, b.x - xm)];
  }

  memberCard(member, taskById, t, c, stop) {
    const openTasks = member.open.map((id) => taskById.get(id)).filter(Boolean);
    const queuedTasks = member.queued.map((id) => taskById.get(id)).filter(Boolean);
    const taskRow = (prefix, it) => h_flex().id(`rm-${prefix}-${it.id}`).gap(8).items_center().px(6).py(4).rounded(4)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { this.task = it.id; cx.notify(); })
      .child(div().flex_none().text_size(SMALL).font_semibold().text_color(t.muted).child(it.id))
      .child(div().flex_1().min_w(0).truncate().text_size(MID).text_color(t.foreground).child(it.title))
      .child(div().flex_none().text_size(SMALL).text_color(this.kindColor(it.kind, t, c)).child(it.status));
    const stateText = member.role === "former" ? "former" : member.state;
    return this.sideCard(t)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(BIG).font_semibold().child(member.name))
        .child(h_flex().id("rm-card-close").size(22).items_center().justify_center().rounded(4).cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop).on_click((_e, cx) => { this.member = null; cx.notify(); }).child("×")))
      .child(div().text_size(SMALL).text_color(t.muted).child(`${member.preset ?? member.role} · ${stateText}`))
      .child(v_flex().gap(4).child(this.section("Open items", t))
        .children(openTasks.length ? openTasks.map((it) => taskRow("mo", it))
          : [div().text_size(SMALL).text_color(t.dim).child("None")]))
      .when(Boolean(member.preset && queuedTasks.length), (el) => el.child(v_flex().gap(4)
        .child(this.section(`In the ${member.preset} queue`, t))
        .children(queuedTasks.map((it) => taskRow("mq", it)))));
  }

  taskCard(task, shorts, roleByName, t, c, stop) {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const fmt = (iso) => {
      const date = iso.slice(0, 10), hhmm = iso.slice(11, 16);
      return date === today ? hhmm : `${date} ${hhmm}`;
    };
    const kc = this.kindColor(task.kind, t, c);
    const pill = h_flex().self_start().relative().px(8).py(2).rounded(4).items_center()
      .child(div().absolute().left(0).top(0).size_full().rounded(4).bg(kc).opacity(0.18))
      .child(div().relative().text_size(SMALL).font_semibold().text_color(kc).child(task.status));
    const touchedEls = [];
    task.touched.forEach((name, idx) => {
      const short = this.shortOf(name, shorts);
      const former = (roleByName.get(name) ?? "former") === "former";
      if (idx > 0) touchedEls.push(div().text_size(SMALL).text_color(t.muted).child(", "));
      touchedEls.push(div().text_size(SMALL).text_color(former ? t.dim : t.foreground).child(short));
    });
    return this.sideCard(t)
      .child(v_flex().gap(4)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().text_size(SMALL).font_semibold().text_color(t.muted).child(task.id))
          .child(h_flex().id("rm-task-close").size(22).items_center().justify_center().rounded(4).cursor_pointer()
            .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", stop).on_click((_e, cx) => { this.task = null; cx.notify(); }).child("×")))
        .child(div().text_size(BIG).font_semibold().child(task.title)))
      .child(v_flex().gap(4).child(pill)
        .when(Boolean(task.queue), (el) => el.child(div().text_size(SMALL).text_color(t.muted).child(`Queue: ${task.queue}`))))
      .child(v_flex().gap(4).child(this.section("Assignments", t))
        .children(task.assignments.length
          ? task.assignments.map((a) => div().text_size(SMALL).text_color(t.foreground)
              .child(`${this.shortOf(a.member, shorts)}  ${a.to ? `${fmt(a.from)} → ${fmt(a.to)}` : `since ${fmt(a.from)}`}`))
          : [div().text_size(SMALL).text_color(t.dim).child("None")]))
      .child(v_flex().gap(4).child(this.section("Touched by", t))
        .child(touchedEls.length ? h_flex().flex_wrap().children(touchedEls) : div().text_size(SMALL).text_color(t.dim).child("None")))
      .when(Boolean(task.prereqs.length), (el) => el.child(div().text_size(SMALL).text_color(t.muted).child(`Needs ${task.prereqs.join(", ")}`)))
      .child(v_flex().gap(4).child(this.section("Log", t))
        .children(task.log.map((e) => div().text_size(SMALL).text_color(t.muted).child(`${fmt(e.at)}  ${this.shortOf(e.by, shorts)}  ${e.change}`))))
      .child(v_flex().gap(4).child(this.section("Brief", t))
        .child(task.brief ? TextView.markdown(`rm-brief-${task.id}`, task.brief) : div().text_size(SMALL).text_color(t.dim).child("No brief")));
  }

  render(cx) {
    const t = theme();
    const c = { done: t.ansi2, active: t.ansi4, partial: t.ansi3, blocked: t.ansi1, quiet: t.dim };
    const stop = (_e, cx) => cx.stop_propagation();

    const frame = (header, ...rest) => v_flex().id(MOD).size_full().min_h(0).overflow_hidden()
      .track_focus(this.keys).on_key_down((e, cx) => this.key(e, cx))
      .bg(t.background).text_color(t.foreground).text_size(MID).child(header).children(rest);
    const bar = (...kids) => h_flex().h(HEAD).flex_none().px(AXIS).gap(16).items_center().bg(t.chrome).children(kids.filter(Boolean));
    const message = (title, text) => frame(bar(div().flex_1().text_color(t.muted).child("Team roadmap")),
      v_flex().flex_1().p(AXIS).gap(8).child(div().text_size(BIG).font_semibold().child(title))
        .child(div().max_w(560).text_color(t.muted).line_height("20px").child(text)));

    if (!this.src.team) {
      return message("No team given",
        "Open it with: team-roadmap open-tab <team> (on the machine the team runs on)");
    }
    if (this.loading) return message("Loading the roadmap…", "");
    if (!this.view) return message("Can't read the roadmap", this.error ?? "");

    const view = this.view;
    const shorts = new Map(view.members.map((m) => [m.name, m.short]));
    const doneCount = view.tasks.filter((i) => i.status === "done").length;

    const btn = (id, label, fn) => h_flex().id(id).h(22).px(8).flex_none().items_center().justify_center().rounded(4)
      .cursor_pointer().text_size(SMALL).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => { fn(); cx.notify(); }).child(label);
    const zoom = h_flex().flex_none().gap(2).items_center()
      .child(btn("rm-zoom-out", "−", () => this.zoomCommand("out")))
      .child(btn("rm-zoom-100", `${Math.round(this.k * 100)}%`, () => this.zoomCommand("1")))
      .child(btn("rm-zoom-in", "+", () => this.zoomCommand("in")))
      .child(btn("rm-zoom-fit", "Fit", () => this.zoomCommand("fit")));

    const header = bar(
      div().flex_none().child(`Team roadmap · ${view.team}`),
      div().flex_1().min_w(0).truncate().text_size(SMALL).text_color(t.dim).child(this.src.machine ?? "this Mac"),
      div().flex_none().text_size(SMALL).text_color(t.muted).child(`${doneCount} of ${view.tasks.length} done`),
      this.error ? div().flex_none().max_w(320).truncate().text_size(SMALL).text_color(c.blocked).child(this.error) : null,
      zoom);

    if (!view.tasks.length) {
      return frame(header, v_flex().flex_1().p(AXIS).gap(8)
        .child(div().text_size(BIG).font_semibold().child("No tasks yet"))
        .child(div().max_w(560).text_color(t.muted).line_height("20px")
          .child(`Add one with: team-roadmap add ${view.team} --title "First task"`)));
    }

    const taskById = new Map(view.tasks.map((it) => [it.id, it]));
    const roleByName = new Map(view.members.map((m) => [m.name, m.role]));
    const lit = this.member ? relatedTo(view, this.member) : null;
    const isDim = (id) => Boolean(lit && !lit.has(id));

    const roster = h_flex().h(HEAD).flex_none().px(AXIS).gap(8).items_center().overflow_hidden()
      .bg(t.chrome).border_t(1).border_color(t.border)
      .children(view.members.map((m) => {
        const selected = this.member === m.name;
        let label = m.short;
        let color = t.dim;
        if (m.role !== "former") {
          if (m.state === "working") {
            label = `${m.short} · ${m.doing[0]}`;
            color = c.active;
          } else {
            label = `${m.short} · idle`;
            color = t.muted;
          }
          if (m.queued.length) label += ` · ${m.queued.length} queued`;
        }
        return h_flex().id(`rm-m-${m.name}`).h(22).px(8).flex_none().items_center().rounded(4)
          .cursor_pointer().text_size(SMALL)
          .when(selected, (el) => el.bg(t.selected).text_color(t.foreground))
          .when(!selected, (el) => el.text_color(color).hover((s) => s.bg(t.hover)))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { this.member = selected ? null : m.name; cx.notify(); })
          .child(label);
      }));

    // Geometry first, unzoomed: each phase block's width and each task's place.
    let x = AXIS, rows = 1;
    const blocks = view.phases.map((p) => ({ title: p.title, tasks: p.tasks, x: 0, w: 0 }));
    for (const b of blocks) {
      b.x = x;
      const g = layout(b.tasks);
      rows = Math.max(rows, g.rows);
      for (const it of b.tasks) { it.x = b.x + 6 + it.d * COL; it.y = TOP + it.r * ROW; }
      b.w = g.cols * COL;
      x += b.w + GAP;
    }
    const W = Math.max(x + 48, 480), H = TOP + (rows - 1) * ROW + 56;
    this.size = { w: W, h: H + 64 };
    this.focusX = blocks[0]?.x ?? 0;
    if (!this.fitted && this.viewport) this.fit();

    const z = (n) => this.z(n), lh = `${z(16)}px`;
    const els = [];
    for (const b of blocks) {
      const bDone = b.tasks.filter((i) => i.status === "done").length;
      els.push(v_flex().absolute().left(z(b.x)).top(0).w(z(Math.max(b.w, 240)))
        .child(div().text_size(z(MID)).line_height(lh).font_semibold().text_color(t.foreground).child(b.title))
        .child(div().mt(z(4)).text_size(z(SMALL)).line_height(lh).text_color(t.muted).child(`${bDone} of ${b.tasks.length} done`)));
      const mine = new Map(b.tasks.map((it) => [it.id, it]));
      for (const it of b.tasks) {
        it.prereqs.filter((p) => mine.has(p) && mine.get(p).d < it.d)
          .forEach((p, lane) => {
            const src = mine.get(p);
            els.push(...this.link(src, it, t, c, lane, Boolean(lit && (!lit.has(src.id) || !lit.has(it.id)))));
          });
      }
      for (const it of b.tasks) {
        const dimmed = isDim(it.id);
        els.push(...this.station(it, t, c, dimmed, this.task === it.id), this.label(it, H, t, dimmed));
        const u = this.under(it, t, c, shorts, dimmed);
        if (u) els.push(u);
      }
    }

    // The band on top: now, ready to start, waiting / blocked / partial.
    const visible = (i) => !lit || lit.has(i.id);
    const now = view.tasks.filter((i) => i.kind === "active" && visible(i));
    const ready = view.tasks.filter((i) => i.kind === "ready" && visible(i));
    const wait = view.tasks.filter((i) => i.kind === "waiting" && visible(i));
    const blocked = view.tasks.filter((i) => i.kind === "blocked" && visible(i));
    const partial = view.tasks.filter((i) => i.kind === "partial" && visible(i));
    const cap = (s) => div().text_size(SMALL).line_height("16px").text_color(t.muted).child(s.toUpperCase());
    const none = () => div().line_height("24px").text_color(t.muted).child("nothing");
    const band = h_flex().flex_none().items_start().gap(GAP).px(AXIS).py(24).bg(t.chrome).border_t(1).border_b(1).border_color(t.border)
      .child(v_flex().flex_none().max_w(560).gap(4).child(cap("Now")).children(now.length ? now.slice(0, 4).map((i) => {
        const owner = this.shortOf(i.owner, shorts);
        return h_flex().gap(8).items_center()
          .child(div().truncate().text_size(BIG).font_semibold().line_height("24px").child(`${i.id} ${i.title}`))
          .when(Boolean(owner), (el) => el.child(div().flex_none().text_color(c.active).child(owner)));
      }) : [none()])
        .when(now.length > 4, (el) => el.child(div().text_size(SMALL).text_color(t.muted).child(`and ${now.length - 4} more`))))
      .child(v_flex().flex_none().max_w(320).gap(4).child(cap("Ready to start"))
        .child(ready.length ? div().line_height("24px").child(ready.map((i) => i.id).join(" · ")) : none()))
      .child(v_flex().flex_1().min_w(0).gap(4).child(cap("Waiting, blocked, partial"))
        .child((wait.length || blocked.length || partial.length)
          ? h_flex().flex_wrap().gap(8).line_height("24px").children([
              ...wait.map((i) => div().text_color(t.muted).child(`${i.id} for ${i.waits.join(", ")}`)),
              ...blocked.map((i) => div().text_color(c.blocked).child(`${i.id} blocked`)),
              ...partial.map((i) => div().text_color(c.partial).child(`${i.id} partial`)),
            ])
          : none()));

    const key = (mark, text) => h_flex().flex_none().gap(8).items_center().child(mark).child(text);
    const dot = (el) => h_flex().size(12).items_center().justify_center().child(el);
    const footer = h_flex().h(HEAD).flex_none().px(AXIS).gap(24).items_center().overflow_hidden().border_t(1).border_color(t.border)
      .text_size(SMALL).text_color(t.muted)
      .child(key(dot(div().size(10).rounded(5).bg(c.active)), "in progress"))
      .child(key(dot(h_flex().size(12).rounded(6).border(2).border_color(c.partial).items_center().justify_center().child(div().size(6).rounded(3).bg(c.partial).opacity(0.5))), "partial"))
      .child(key(dot(div().size(12).rounded(6).border(2).border_color(t.foreground)), "ready to start"))
      .child(key(dot(div().size(12).rounded(6).border(1).border_color(c.quiet)), "waiting"))
      .child(key(dot(div().size(12).rounded(6).bg(c.blocked)), "blocked"))
      .child(key(dot(div().size(12).rounded(6).bg(c.done)), "done"))
      .child(key(dot(div().size(12).rounded(2).border(1).border_color(c.quiet)), "parked"))
      .child(key(div().text_color(t.muted).child("worker queue"), "unassigned, any member of that role can claim it"))
      .child(key(div().w(24).h(0).border_t(1).border_color(c.quiet), "requirement met"))
      .child(key(div().w(24).h(0).border_t(2).border_dashed().border_color(t.foreground), "still blocking"))
      .child(div().flex_1())
      .child(div().flex_none().text_color(t.dim).child("⌘ + scroll to zoom · drag to move"));

    const map = div().id("rm-view").flex_1().min_w(0).min_h(0).h_full().relative().overflow_hidden().cursor_grab()
      .on_size_change((size, cx) => { this.viewport = size; if (!this.fitted) this.fit(); else this.clamp(); cx.notify(); })
      .on_scroll_wheel((e, cx) => {
        if (e.modifiers.platform || e.modifiers.control) {
          const dy = e.delta_lines ? e.delta_lines.y * 40 : e.delta.y;
          this.zoomTo(this.k * Math.exp(dy / 300), e.local_position);
        } else { this.ox -= e.delta.x; this.oy -= e.delta.y; this.clamp(); }
        cx.notify();
      })
      .on_mouse_down("left", (e) => { this.drag = { x: e.position.x, y: e.position.y, ox: this.ox, oy: this.oy }; this.moved = false; this.keys.focus(); })
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        const dx = e.position.x - this.drag.x, dy = e.position.y - this.drag.y;
        if (!this.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        this.moved = true;
        this.ox = this.drag.ox - dx; this.oy = this.drag.oy - dy; this.clamp();
        cx.notify();
      })
      .on_mouse_up("left", () => { this.drag = null; })
      .child(div().absolute().left(-this.ox).top(-this.oy).w(z(W)).h(z(H + 64))
        .child(div().absolute().left(0).top(z(32)).w(z(W)).h(z(H)).children(els)));

    const activeTask = this.task ? taskById.get(this.task) ?? null : null;
    const activeMember = this.member ? view.members.find((m) => m.name === this.member) ?? null : null;
    const card = activeTask
      ? this.taskCard(activeTask, shorts, roleByName, t, c, stop)
      : activeMember
        ? this.memberCard(activeMember, taskById, t, c, stop)
        : null;
    const body = card ? h_flex().flex_1().min_h(0).child(map).child(card) : map;

    return frame(header, roster, band, body, footer);
  }
}
