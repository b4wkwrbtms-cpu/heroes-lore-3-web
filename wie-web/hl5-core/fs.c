// Virtual file system for the guest's libc calls. The game's data.vfs lives in JS and is read on
// demand; everything else (saves) is kept in host memory and mirrored to IndexedDB by the page.
#include "base.h"

#define MAX_NODES 512
#define MAX_FDS 64
#define PATH_MAX_LEN 160

typedef struct {
  char path[PATH_MAX_LEN];
  int used, dir, external;
  u8 *data;
  u32 size, cap;
  double ext_size;
} Node;

typedef struct {
  int used;
  Node *node;
  u32 pos;
  int flags;
  int dirty;
} Fd;

static Node nodes[MAX_NODES];
static Fd fds[MAX_FDS];
u32 guest_errno_addr;

static void set_errno(int e) { wr32(guest_errno_addr, (u32)e); }

static void normalize(const char *in, char *out) {
  // collapse "//", "/./" and resolve "..", keep a leading slash
  char tmp[PATH_MAX_LEN];
  int n = 0;
  int i = 0;
  tmp[n++] = '/';
  while (in[i] && n < PATH_MAX_LEN - 2) {
    while (in[i] == '/') i++;
    if (!in[i]) break;
    int s = i;
    while (in[i] && in[i] != '/') i++;
    int len = i - s;
    if (len == 1 && in[s] == '.') continue;
    if (len == 2 && in[s] == '.' && in[s + 1] == '.') {
      if (n > 1) {
        n--;
        while (n > 1 && tmp[n - 1] != '/') n--;
      }
      continue;
    }
    if (n > 1 && tmp[n - 1] != '/') tmp[n++] = '/';
    for (int k = 0; k < len && n < PATH_MAX_LEN - 2; k++) tmp[n++] = in[s + k];
  }
  if (n > 1 && tmp[n - 1] == '/') n--;
  tmp[n] = 0;
  memcpy(out, tmp, n + 1);
}

static Node *find_node(const char *p) {
  for (int i = 0; i < MAX_NODES; i++)
    if (nodes[i].used && !hstrcmp(nodes[i].path, p)) return &nodes[i];
  return 0;
}

static Node *new_node(const char *p, int dir) {
  for (int i = 0; i < MAX_NODES; i++) {
    if (!nodes[i].used) {
      Node *n = &nodes[i];
      memset(n, 0, sizeof *n);
      n->used = 1;
      n->dir = dir;
      memcpy(n->path, p, hstrlen(p) + 1);
      return n;
    }
  }
  logf("fs: out of nodes");
  return 0;
}

static void ensure_parents(const char *p) {
  char tmp[PATH_MAX_LEN];
  int len = hstrlen(p);
  for (int i = 1; i < len; i++) {
    if (p[i] == '/') {
      memcpy(tmp, p, i);
      tmp[i] = 0;
      if (!find_node(tmp)) new_node(tmp, 1);
    }
  }
}

static void guest_path(u32 a, char *out) {
  char raw[PATH_MAX_LEN];
  int i = 0;
  for (; i < PATH_MAX_LEN - 1; i++) {
    raw[i] = (char)rd8(a + i);
    if (!raw[i]) break;
  }
  raw[i] = 0;
  normalize(raw, out);
}

static void persist(Node *n) {
  if (n->external || n->dir) return;
  host_file_saved(n->path, hstrlen(n->path), n->data, n->size);
}

static int reserve(Node *n, u32 size) {
  if (size <= n->cap) return 1;
  u32 cap = n->cap ? n->cap : 256;
  while (cap < size) cap *= 2;
  u8 *d = hmalloc(cap);
  if (!d) return 0;
  if (n->data) { memcpy(d, n->data, n->size); hfree(n->data); }
  n->data = d;
  n->cap = cap;
  return 1;
}

static int alloc_fd(Node *n, int flags) {
  for (int i = 3; i < MAX_FDS; i++) {
    if (!fds[i].used) {
      fds[i].used = 1;
      fds[i].node = n;
      fds[i].pos = 0;
      fds[i].flags = flags;
      fds[i].dirty = 0;
      return i;
    }
  }
  return -1;
}

// ---- exports for the page --------------------------------------------------------------
EXPORT(fs_put) void fs_put(const char *path, const u8 *data, u32 len) {
  char p[PATH_MAX_LEN];
  normalize(path, p);
  ensure_parents(p);
  Node *n = find_node(p);
  if (!n) n = new_node(p, 0);
  if (!n) return;
  n->size = 0;
  if (!reserve(n, len)) return;
  memcpy(n->data, data, len);
  n->size = len;
}

EXPORT(fs_mount_external) void fs_mount_external(const char *path, double size) {
  char p[PATH_MAX_LEN];
  normalize(path, p);
  ensure_parents(p);
  Node *n = find_node(p);
  if (!n) n = new_node(p, 0);
  n->external = 1;
  n->ext_size = size;
}

int fs_open_external(const char *path) {
  char p[PATH_MAX_LEN];
  normalize(path, p);
  Node *n = find_node(p);
  return n ? alloc_fd(n, 0) : -1;
}

// ---- libc -----------------------------------------------------------------------------
static u32 node_size(Node *n) { return n->external ? (u32)n->ext_size : n->size; }

int fs_open(u32 gpath, int flags) {
  char p[PATH_MAX_LEN];
  guest_path(gpath, p);
  Node *n = find_node(p);
  if (n && n->dir && (flags & 3)) { set_errno(21); return -1; }
  if (!n) {
    if (!(flags & 0x40)) { set_errno(2); return -1; }
    ensure_parents(p);
    n = new_node(p, 0);
    if (!n) { set_errno(28); return -1; }
  } else if ((flags & 0x40) && (flags & 0x80)) {
    set_errno(17);
    return -1;
  }
  int fd = alloc_fd(n, flags);
  if (fd < 0) { set_errno(24); return -1; }
  if ((flags & 0x200) && !n->external && !n->dir) { n->size = 0; fds[fd].dirty = 1; }
  if (flags & 0x400) fds[fd].pos = node_size(n);
  return fd;
}

int fs_close(int fd) {
  if (fd < 3 || fd >= MAX_FDS || !fds[fd].used) { set_errno(9); return -1; }
  if (fds[fd].dirty) persist(fds[fd].node);
  fds[fd].used = 0;
  return 0;
}

int fs_read(int fd, u32 buf, u32 len) {
  if (fd < 3 || fd >= MAX_FDS || !fds[fd].used) { set_errno(9); return -1; }
  Fd *f = &fds[fd];
  Node *n = f->node;
  if (n->dir) { set_errno(21); return -1; }
  u32 size = node_size(n);
  if (f->pos >= size) return 0;
  if (len > size - f->pos) len = size - f->pos;
  if (n->external) {
    int got = host_vfs_read((double)f->pos, gptr(buf), (int)len);
    if (got < 0) { set_errno(5); return -1; }
    len = (u32)got;
  } else {
    memcpy(gptr(buf), n->data + f->pos, len);
  }
  f->pos += len;
  return (int)len;
}

int fs_write(int fd, u32 buf, u32 len) {
  if (fd >= 1 && fd <= 2) {
    host_log((const char *)gptr(buf), (int)len);
    return (int)len;
  }
  if (fd < 3 || fd >= MAX_FDS || !fds[fd].used) { set_errno(9); return -1; }
  Fd *f = &fds[fd];
  Node *n = f->node;
  if (n->external || n->dir) { set_errno(9); return -1; }
  if (f->flags & 0x400) f->pos = n->size;
  if (!reserve(n, f->pos + len)) { set_errno(28); return -1; }
  if (f->pos > n->size) memset(n->data + n->size, 0, f->pos - n->size);
  memcpy(n->data + f->pos, gptr(buf), len);
  f->pos += len;
  if (f->pos > n->size) n->size = f->pos;
  f->dirty = 1;
  return (int)len;
}

s64 fs_lseek(int fd, s64 off, int whence) {
  if (fd < 3 || fd >= MAX_FDS || !fds[fd].used) { set_errno(9); return -1; }
  Fd *f = &fds[fd];
  s64 base = whence == 0 ? 0 : whence == 1 ? f->pos : node_size(f->node);
  s64 np = base + off;
  if (np < 0) { set_errno(22); return -1; }
  f->pos = (u32)np;
  return np;
}

int fs_dup(int fd) {
  if (fd < 3 || fd >= MAX_FDS || !fds[fd].used) { set_errno(9); return -1; }
  int n = alloc_fd(fds[fd].node, fds[fd].flags);
  if (n >= 0) fds[n].pos = fds[fd].pos;
  return n;
}

int fs_stat(u32 gpath, u32 st) {
  char p[PATH_MAX_LEN];
  guest_path(gpath, p);
  Node *n = find_node(p);
  if (!n) {
    // a directory exists implicitly when any node lives below it
    int len = hstrlen(p);
    for (int i = 0; i < MAX_NODES; i++) {
      if (nodes[i].used && !memcmp(nodes[i].path, p, len) && nodes[i].path[len] == '/') { n = new_node(p, 1); break; }
    }
    if (!n) { set_errno(2); return -1; }
  }
  memset(gptr(st), 0, 104);
  wr32(st + 16, n->dir ? 0040777 : 0100666);
  wr32(st + 20, 1);
  u32 size = node_size(n);
  wr32(st + 48, size);
  wr32(st + 52, 0);
  wr32(st + 56, 4096);
  wr32(st + 64, (size + 511) / 512);
  return 0;
}

int fs_access(u32 gpath) {
  char p[PATH_MAX_LEN];
  guest_path(gpath, p);
  if (find_node(p)) return 0;
  set_errno(2);
  return -1;
}

int fs_mkdir(u32 gpath) {
  char p[PATH_MAX_LEN];
  guest_path(gpath, p);
  if (find_node(p)) { set_errno(17); return -1; }
  ensure_parents(p);
  new_node(p, 1);
  return 0;
}

int fs_unlink(u32 gpath, int dir) {
  char p[PATH_MAX_LEN];
  guest_path(gpath, p);
  Node *n = find_node(p);
  if (!n || n->dir != dir) { set_errno(n ? (dir ? 20 : 21) : 2); return -1; }
  if (n->data) hfree(n->data);
  n->used = 0;
  if (!dir) host_file_deleted(p, hstrlen(p));
  return 0;
}

int fs_rename(u32 from, u32 to) {
  char a[PATH_MAX_LEN], b[PATH_MAX_LEN];
  guest_path(from, a);
  guest_path(to, b);
  Node *n = find_node(a);
  if (!n) { set_errno(2); return -1; }
  Node *old = find_node(b);
  if (old && old != n) {
    if (old->data) hfree(old->data);
    old->used = 0;
  }
  ensure_parents(b);
  memcpy(n->path, b, hstrlen(b) + 1);
  if (!n->dir) {
    host_file_deleted(a, hstrlen(a));
    persist(n);
  }
  return 0;
}
