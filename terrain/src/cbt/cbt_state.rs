//! Bit-exact Rust port of the CBT ROAM tree (src/systems/lod/cbt/cbt_state.ts):
//! an octahedron-rooted binary-triangle tree in a typed-array pool, refined by the
//! forced-diamond split (watertight + restricted) and collapsed conservatively.
//!
//! Topology uses only integer pointer manipulation, `+`/`*`/`floor`/`sqrt` on f64,
//! and exact float-equality on the shared-hypotenuse vertex — so a faithful port is
//! bit-identical to the TS tree (validated by cbt_scenario_test.rs). Slot allocation
//! and free order are preserved exactly because they drive which slots later splits
//! reuse, which is observable in the leaf order and cross-links.

/// One materialized leaf triangle — mirrors `CbtNode` in cbt_state.ts.
#[derive(Clone, Copy, Debug)]
pub struct CbtLeaf {
    pub id: usize,
    pub level: u8,
    /// parent slot, or -1 for a root.
    pub parent: i32,
    pub v0: [f64; 3], // apex
    pub v1: [f64; 3], // left base
    pub v2: [f64; 3], // right base
}

// Octahedron vertices.
const VX: [[f64; 3]; 6] = [
    [1.0, 0.0, 0.0],
    [-1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, -1.0, 0.0],
    [0.0, 0.0, 1.0],
    [0.0, 0.0, -1.0],
];

const ROOT_ALR: [[usize; 3]; 8] = [
    [2, 0, 4],
    [2, 4, 1],
    [2, 1, 5],
    [2, 5, 0],
    [3, 0, 4],
    [3, 4, 1],
    [3, 1, 5],
    [3, 5, 0],
];

const ROOT_NEIGHBORS: [[i32; 3]; 8] = [
    [4, 3, 1],
    [5, 0, 2],
    [6, 1, 3],
    [7, 2, 0],
    [0, 7, 5],
    [1, 4, 6],
    [2, 5, 7],
    [3, 6, 4],
];

const BASE: usize = 0;
const LEFT: usize = 1;
const RIGHT: usize = 2;
const INITIAL_CAPACITY: usize = 4096;

fn midpoint_on_sphere(
    ax: f64,
    ay: f64,
    az: f64,
    bx: f64,
    by: f64,
    bz: f64,
    radius: f64,
) -> [f64; 3] {
    let mut mx = (ax + bx) * 0.5;
    let mut my = (ay + by) * 0.5;
    let mut mz = (az + bz) * 0.5;
    let mut len = (mx * mx + my * my + mz * mz).sqrt();
    if len < 1e-12 {
        mx = ax;
        my = ay;
        mz = az;
        len = (mx * mx + my * my + mz * mz).sqrt();
    }
    let s = radius / len;
    [mx * s, my * s, mz * s]
}

#[inline]
fn test_bit(field: &[u32], i: usize) -> bool {
    (field[i >> 5] >> (i & 31)) & 1 == 1
}
#[inline]
fn set_bit(field: &mut [u32], i: usize) {
    field[i >> 5] |= 1u32 << (i & 31);
}
#[inline]
fn clear_bit(field: &mut [u32], i: usize) {
    field[i >> 5] &= !(1u32 << (i & 31));
}

pub struct CbtState {
    pub radius_sim: f64,
    pub max_depth: u32,
    cap: usize,
    verts: Vec<f64>, // cap*9 — apex(0-2) left(3-5) right(6-8)
    level: Vec<u8>,
    parent: Vec<i32>,
    child0: Vec<i32>,
    child1: Vec<i32>,
    neighbors: Vec<i32>, // cap*3 — [base,left,right], -1 = none
    alive: Vec<u32>,
    leaf_bits: Vec<u32>,
    free_stack: Vec<i32>,
    free_top: usize,
    next_fresh: usize,
    leaf_count: usize,
}

impl CbtState {
    pub fn new(radius_sim: f64, max_depth: u32) -> Self {
        let mut s = CbtState {
            radius_sim,
            max_depth,
            cap: 0,
            verts: Vec::new(),
            level: Vec::new(),
            parent: Vec::new(),
            child0: Vec::new(),
            child1: Vec::new(),
            neighbors: Vec::new(),
            alive: Vec::new(),
            leaf_bits: Vec::new(),
            free_stack: Vec::new(),
            free_top: 0,
            next_fresh: 0,
            leaf_count: 0,
        };
        s.alloc_arrays(INITIAL_CAPACITY);
        for i in 0..ROOT_ALR.len() {
            let [a, l, r] = ROOT_ALR[i];
            let slot = s.alloc_slot(); // roots get slots 0..7 in order
            s.level[slot] = 0;
            s.parent[slot] = -1;
            s.child0[slot] = -1;
            s.child1[slot] = -1;
            s.write_verts_scaled(slot, VX[a], VX[l], VX[r], radius_sim);
            set_bit(&mut s.leaf_bits, slot);
            s.leaf_count += 1;
        }
        for i in 0..ROOT_NEIGHBORS.len() {
            let [b, l, r] = ROOT_NEIGHBORS[i];
            s.neighbors[i * 3 + BASE] = b;
            s.neighbors[i * 3 + LEFT] = l;
            s.neighbors[i * 3 + RIGHT] = r;
        }
        s
    }

    pub fn leaf_count(&self) -> usize {
        self.leaf_count
    }

    pub fn get_leaf_nodes(&self) -> Vec<CbtLeaf> {
        let mut out = Vec::new();
        for slot in 0..self.next_fresh {
            if !test_bit(&self.alive, slot) {
                continue;
            }
            if !test_bit(&self.leaf_bits, slot) {
                continue;
            }
            let o = slot * 9;
            out.push(CbtLeaf {
                id: slot,
                level: self.level[slot],
                parent: self.parent[slot],
                v0: [self.verts[o], self.verts[o + 1], self.verts[o + 2]],
                v1: [self.verts[o + 3], self.verts[o + 4], self.verts[o + 5]],
                v2: [self.verts[o + 6], self.verts[o + 7], self.verts[o + 8]],
            });
        }
        out
    }

    pub fn split_by_priority(&mut self, node_ids: &[usize], max_splits: u32) -> u32 {
        let mut split_count = 0;
        for &id in node_ids {
            if split_count >= max_splits {
                break;
            }
            if self.request_split(id) {
                split_count += 1;
            }
        }
        split_count
    }

    pub fn merge_by_parent_priority(&mut self, parent_ids: &[usize], max_merges: u32) -> u32 {
        let mut merge_count = 0;
        for &id in parent_ids {
            if merge_count >= max_merges {
                break;
            }
            if self.merge(id) {
                merge_count += 1;
            }
        }
        merge_count
    }

    // --- pool internals -----------------------------------------------------

    fn alloc_arrays(&mut self, cap: usize) {
        let words = cap.div_ceil(32);
        self.verts = vec![0.0; cap * 9];
        self.level = vec![0u8; cap];
        self.parent = vec![-1i32; cap];
        self.child0 = vec![-1i32; cap];
        self.child1 = vec![-1i32; cap];
        self.neighbors = vec![-1i32; cap * 3];
        self.alive = vec![0u32; words];
        self.leaf_bits = vec![0u32; words];
        self.free_stack = vec![0i32; cap];
        self.cap = cap;
    }

    fn grow(&mut self) {
        let new_cap = self.cap * 2;
        let words = new_cap.div_ceil(32);
        // resize preserves existing elements and fills the new tail (matches the
        // TS grow(): old arrays copied into fresh -1/0-filled arrays).
        self.verts.resize(new_cap * 9, 0.0);
        self.level.resize(new_cap, 0);
        self.parent.resize(new_cap, -1);
        self.child0.resize(new_cap, -1);
        self.child1.resize(new_cap, -1);
        self.neighbors.resize(new_cap * 3, -1);
        self.alive.resize(words, 0);
        self.leaf_bits.resize(words, 0);
        self.free_stack.resize(new_cap, 0);
        self.cap = new_cap;
    }

    fn alloc_slot(&mut self) -> usize {
        let slot = if self.free_top > 0 {
            self.free_top -= 1;
            self.free_stack[self.free_top] as usize
        } else {
            if self.next_fresh >= self.cap {
                self.grow();
            }
            let s = self.next_fresh;
            self.next_fresh += 1;
            s
        };
        set_bit(&mut self.alive, slot);
        slot
    }

    fn free_slot(&mut self, slot: usize) {
        clear_bit(&mut self.alive, slot);
        clear_bit(&mut self.leaf_bits, slot);
        self.neighbors[slot * 3 + BASE] = -1;
        self.neighbors[slot * 3 + LEFT] = -1;
        self.neighbors[slot * 3 + RIGHT] = -1;
        self.free_stack[self.free_top] = slot as i32;
        self.free_top += 1;
    }

    #[inline]
    fn nb(&self, slot: usize, edge: usize) -> i32 {
        self.neighbors[slot * 3 + edge]
    }
    #[inline]
    fn set_nb(&mut self, slot: i32, edge: usize, value: i32) {
        if slot >= 0 {
            self.neighbors[slot as usize * 3 + edge] = value;
        }
    }
    fn replace_neighbor(&mut self, x: i32, old_t: i32, new_t: i32) {
        if x < 0 {
            return;
        }
        let o = x as usize * 3;
        if self.neighbors[o + BASE] == old_t {
            self.neighbors[o + BASE] = new_t;
        }
        if self.neighbors[o + LEFT] == old_t {
            self.neighbors[o + LEFT] = new_t;
        }
        if self.neighbors[o + RIGHT] == old_t {
            self.neighbors[o + RIGHT] = new_t;
        }
    }

    fn write_verts_scaled(&mut self, slot: usize, a: [f64; 3], l: [f64; 3], r: [f64; 3], radius: f64) {
        let o = slot * 9;
        self.verts[o] = a[0] * radius;
        self.verts[o + 1] = a[1] * radius;
        self.verts[o + 2] = a[2] * radius;
        self.verts[o + 3] = l[0] * radius;
        self.verts[o + 4] = l[1] * radius;
        self.verts[o + 5] = l[2] * radius;
        self.verts[o + 6] = r[0] * radius;
        self.verts[o + 7] = r[1] * radius;
        self.verts[o + 8] = r[2] * radius;
    }

    // --- refinement (ROAM forced-diamond split) -----------------------------

    fn request_split(&mut self, slot: usize) -> bool {
        if slot >= self.next_fresh {
            return false;
        }
        if !test_bit(&self.alive, slot) {
            return false;
        }
        if !test_bit(&self.leaf_bits, slot) {
            return false;
        }
        if self.level[slot] as u32 >= self.max_depth {
            return false;
        }
        self.force_split(slot);
        true
    }

    fn force_split(&mut self, t: usize) {
        if !test_bit(&self.leaf_bits, t) {
            return; // already split
        }
        if self.level[t] as u32 >= self.max_depth {
            return;
        }

        let mut tb = self.nb(t, BASE);
        if tb != -1 && self.nb(tb as usize, BASE) != t as i32 {
            // Base neighbour is coarser / not a diamond partner — split it first.
            self.force_split(tb as usize);
            tb = self.nb(t, BASE); // refetch: now a same-level child
        }

        // Read t's left base vertex BEFORE subdividing (verts unchanged by subdivide).
        let t_l = t * 9 + 3;
        let tlx = self.verts[t_l];
        let tly = self.verts[t_l + 1];
        let tlz = self.verts[t_l + 2];

        let (t0, t1) = self.subdivide(t);
        if tb == -1 {
            self.set_nb(t0 as i32, RIGHT, -1);
            self.set_nb(t1 as i32, LEFT, -1);
            return;
        }
        // Orientation of the shared hypotenuse (exact float equality, as in TS).
        let b_l = tb as usize * 9 + 3;
        let tb_left_is_tl =
            self.verts[b_l] == tlx && self.verts[b_l + 1] == tly && self.verts[b_l + 2] == tlz;

        let (tb0, tb1) = self.subdivide(tb as usize);
        if tb_left_is_tl {
            self.set_nb(t0 as i32, RIGHT, tb0 as i32);
            self.set_nb(tb0 as i32, RIGHT, t0 as i32);
            self.set_nb(t1 as i32, LEFT, tb1 as i32);
            self.set_nb(tb1 as i32, LEFT, t1 as i32);
        } else {
            self.set_nb(t0 as i32, RIGHT, tb1 as i32);
            self.set_nb(tb1 as i32, LEFT, t0 as i32);
            self.set_nb(t1 as i32, LEFT, tb0 as i32);
            self.set_nb(tb0 as i32, RIGHT, t1 as i32);
        }
    }

    fn subdivide(&mut self, t: usize) -> (usize, usize) {
        let o = t * 9;
        let ax = self.verts[o];
        let ay = self.verts[o + 1];
        let az = self.verts[o + 2];
        let lx = self.verts[o + 3];
        let ly = self.verts[o + 4];
        let lz = self.verts[o + 5];
        let rx = self.verts[o + 6];
        let ry = self.verts[o + 7];
        let rz = self.verts[o + 8];
        let mid = midpoint_on_sphere(lx, ly, lz, rx, ry, rz, self.radius_sim);
        let (mx, my, mz) = (mid[0], mid[1], mid[2]);

        let lvl = self.level[t] + 1;
        let x_l = self.nb(t, LEFT);
        let x_r = self.nb(t, RIGHT);

        let t0 = self.alloc_slot();
        let t1 = self.alloc_slot();

        // t0 = (apex=VC, left=A, right=L)
        let mut p = t0 * 9;
        self.verts[p] = mx;
        self.verts[p + 1] = my;
        self.verts[p + 2] = mz;
        self.verts[p + 3] = ax;
        self.verts[p + 4] = ay;
        self.verts[p + 5] = az;
        self.verts[p + 6] = lx;
        self.verts[p + 7] = ly;
        self.verts[p + 8] = lz;
        self.level[t0] = lvl;
        self.parent[t0] = t as i32;
        self.child0[t0] = -1;
        self.child1[t0] = -1;
        set_bit(&mut self.leaf_bits, t0);

        // t1 = (apex=VC, left=R, right=A)
        p = t1 * 9;
        self.verts[p] = mx;
        self.verts[p + 1] = my;
        self.verts[p + 2] = mz;
        self.verts[p + 3] = rx;
        self.verts[p + 4] = ry;
        self.verts[p + 5] = rz;
        self.verts[p + 6] = ax;
        self.verts[p + 7] = ay;
        self.verts[p + 8] = az;
        self.level[t1] = lvl;
        self.parent[t1] = t as i32;
        self.child0[t1] = -1;
        self.child1[t1] = -1;
        set_bit(&mut self.leaf_bits, t1);

        // Internal shared edge (VC,A): t0.LEFT <-> t1.RIGHT.
        self.set_nb(t0 as i32, LEFT, t1 as i32);
        self.set_nb(t1 as i32, RIGHT, t0 as i32);

        // Child base = parent leg; redirect the leg neighbour to point at the child.
        self.set_nb(t0 as i32, BASE, x_l);
        self.replace_neighbor(x_l, t as i32, t0 as i32);
        self.set_nb(t1 as i32, BASE, x_r);
        self.replace_neighbor(x_r, t as i32, t1 as i32);

        // Mark t internal.
        self.child0[t] = t0 as i32;
        self.child1[t] = t1 as i32;
        clear_bit(&mut self.leaf_bits, t);
        self.leaf_count += 1; // -1 parent, +2 children

        (t0, t1)
    }

    // --- decimation (conservative diamond collapse) -------------------------

    fn merge(&mut self, parent_slot: usize) -> bool {
        if parent_slot >= self.next_fresh {
            return false;
        }
        if !test_bit(&self.alive, parent_slot) {
            return false;
        }
        if test_bit(&self.leaf_bits, parent_slot) {
            return false; // already a leaf
        }

        let t0 = self.child0[parent_slot];
        let t1 = self.child1[parent_slot];
        if t0 == -1 || t1 == -1 {
            return false;
        }
        if !test_bit(&self.leaf_bits, t0 as usize) || !test_bit(&self.leaf_bits, t1 as usize) {
            return false;
        }

        // Diamond partner = parent of t0's cross neighbour (t0.RIGHT).
        let tb1 = self.nb(t0 as usize, RIGHT);
        if tb1 == -1 {
            self.collapse_one(parent_slot, t0 as usize, t1 as usize);
            return true;
        }
        let tb = self.parent[tb1 as usize];
        if tb < 0 || test_bit(&self.leaf_bits, tb as usize) {
            return false;
        }
        let tb0 = self.child0[tb as usize];
        let tb1c = self.child1[tb as usize];
        if tb0 == -1 || tb1c == -1 {
            return false;
        }
        if !test_bit(&self.leaf_bits, tb0 as usize) || !test_bit(&self.leaf_bits, tb1c as usize) {
            return false;
        }

        self.collapse_one(parent_slot, t0 as usize, t1 as usize);
        self.collapse_one(tb as usize, tb0 as usize, tb1c as usize);
        self.set_nb(parent_slot as i32, BASE, tb);
        self.set_nb(tb, BASE, parent_slot as i32);
        true
    }

    fn collapse_one(&mut self, t: usize, t0: usize, t1: usize) {
        let x_l = self.nb(t0, BASE); // child t0's base == parent's LEFT leg
        let x_r = self.nb(t1, BASE); // child t1's base == parent's RIGHT leg
        self.replace_neighbor(x_l, t0 as i32, t as i32);
        self.replace_neighbor(x_r, t1 as i32, t as i32);
        self.set_nb(t as i32, LEFT, x_l);
        self.set_nb(t as i32, RIGHT, x_r);

        self.free_slot(t0);
        self.free_slot(t1);
        self.child0[t] = -1;
        self.child1[t] = -1;
        set_bit(&mut self.leaf_bits, t);
        self.leaf_count -= 1; // -2 children, +1 parent
    }

    // --- conformity invariants (used by tests) ------------------------------

    /// Watertight + restricted check: every leaf's neighbours are alive, the
    /// neighbour relation is symmetric, and edge-adjacent leaves differ by <= 1
    /// level. Mirrors the TS conformity test.
    #[cfg(test)]
    pub fn assert_conformity(&self) {
        for slot in 0..self.next_fresh {
            if !test_bit(&self.alive, slot) || !test_bit(&self.leaf_bits, slot) {
                continue;
            }
            for edge in 0..3 {
                let n = self.nb(slot, edge);
                if n < 0 {
                    continue;
                }
                let n = n as usize;
                assert!(test_bit(&self.alive, n), "neighbour {n} of {slot} not alive");
                // restricted: level difference at most 1
                let dl = (self.level[slot] as i32 - self.level[n] as i32).abs();
                assert!(dl <= 1, "level diff {dl} between {slot} and {n}");
                // symmetry: n must point back at slot on one of its edges
                let back = (0..3).any(|e| self.nb(n, e) == slot as i32);
                assert!(back, "neighbour {n} does not point back at {slot}");
            }
        }
    }
}
