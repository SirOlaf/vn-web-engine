/* Pluto 2.4 persistence ("pluto" library) for the embedded Lua 5.1.5 VM.
 *
 * Artemis executables embed stock Pluto 2.4 built for x64 Windows (luaopen 0x1401c6c90,
 * persist 0x1401c3f50, unpersist 0x1401c69e0). The byte stream therefore stores C int
 * fields as 4 bytes and size_t, pointer and ptrdiff_t fields as 8 bytes, all
 * little-endian. This module writes and reads that x64 layout from the 32-bit wasm build.
 *
 * Stream: every value starts with int firstTime. 0 is followed by int ref (0 = nil,
 * otherwise an earlier object). 1 is followed by int ref (the 1-based object counter),
 * int type and the type payload; type 101 is a permanent, whose payload is the persisted
 * key into the perms table. Tables and userdata start with int isspecial (__persist
 * metafunction result follows when 1). */
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "lua.h"
#include "lauxlib.h"
#include "lobject.h"
#include "lstate.h"
#include "lfunc.h"
#include "lgc.h"
#include "lmem.h"
#include "lstring.h"
#include "ldo.h"
#include "lopcodes.h"

#define PLUTO_TPERMANENT 101

/* Stack slots relative to the current top; 1 is perms and 2 the reference table. */
#define getobject(L, i) ((L)->top + (i))

static void pushtagged(lua_State *L, GCObject *o, int tt) {
  L->top->value.gc = o;
  L->top->tt = tt;
  L->top++;
}

/* --- persist --------------------------------------------------------------------- */

typedef struct {
  char *data;
  size_t length, capacity;
} Buffer;

typedef struct {
  lua_State *L;
  int counter;
  Buffer *buffer;
} PersistInfo;

static int buffer_gc(lua_State *L) {
  Buffer *b = (Buffer *)lua_touserdata(L, 1);
  free(b->data);
  b->data = NULL;
  return 0;
}

static void write_bytes(PersistInfo *pi, const void *p, size_t n) {
  Buffer *b = pi->buffer;
  if (b->length + n > b->capacity) {
    size_t capacity = b->capacity ? b->capacity : 256;
    while (capacity < b->length + n) capacity *= 2;
    char *data = (char *)realloc(b->data, capacity);
    if (!data) luaL_error(pi->L, "not enough memory");
    b->data = data;
    b->capacity = capacity;
  }
  memcpy(b->data + b->length, p, n);
  b->length += n;
}
static void write_int(PersistInfo *pi, int value) { write_bytes(pi, &value, 4); }
static void write_byte(PersistInfo *pi, lu_byte value) { write_bytes(pi, &value, 1); }
/* x64 size_t, pointer and ptrdiff_t fields. */
static void write_wide(PersistInfo *pi, int64_t value) { write_bytes(pi, &value, 8); }

static void persist(PersistInfo *pi);

/* 0x1401c27d0: returns 1 when the __persist metafunction replaced the literal form. */
static int persistspecialobject(PersistInfo *pi, int defaction) {
  lua_State *L = pi->L;
  lua_checkstack(L, 4);
  if (!lua_getmetatable(L, -1)) {
    if (defaction) {
      write_int(pi, 0);
      return 0;
    }
    lua_pushliteral(L, "Type not literally persistable by default");
    lua_error(L);
  }
  lua_pushliteral(L, "__persist");
  lua_rawget(L, -2);
  if (lua_isnil(L, -1)) {
    lua_pop(L, 2);
    if (defaction) {
      write_int(pi, 0);
      return 0;
    }
    lua_pushliteral(L, "Type not literally persistable by default");
    lua_error(L);
  } else if (lua_isboolean(L, -1)) {
    if (lua_toboolean(L, -1)) {
      lua_pop(L, 2);
      write_int(pi, 0);
      return 0;
    }
    lua_pushliteral(L, "Metatable forbade persistence");
    lua_error(L);
  } else if (!lua_isfunction(L, -1)) {
    lua_pushliteral(L, "__persist not nil, boolean, or function");
    lua_error(L);
  }
  lua_pushvalue(L, -3);
  lua_call(L, 1, 1);
  if (!lua_isfunction(L, -1)) {
    lua_pushliteral(L, "__persist function did not return a function");
    lua_error(L);
  }
  write_int(pi, 1);
  persist(pi);
  lua_pop(L, 2);
  return 1;
}

/* 0x1401c2b00 */
static void persisttable(PersistInfo *pi) {
  lua_State *L = pi->L;
  lua_checkstack(L, 3);
  if (persistspecialobject(pi, 1)) return;
  if (!lua_getmetatable(L, -1)) lua_pushnil(L);
  persist(pi);
  lua_pop(L, 1);
  lua_pushnil(L);
  while (lua_next(L, -2)) {
    lua_pushvalue(L, -2);
    persist(pi);
    lua_pop(L, 1);
    persist(pi);
    lua_pop(L, 1);
  }
  lua_pushnil(L);
  persist(pi);
  lua_pop(L, 1);
}

/* 0x1401c2cc0 */
static void persistuserdata(PersistInfo *pi) {
  lua_State *L = pi->L;
  lua_checkstack(L, 2);
  if (persistspecialobject(pi, 0)) return;
  size_t length = uvalue(getobject(L, -1))->len;
  write_wide(pi, (int64_t)length);
  write_bytes(pi, lua_touserdata(L, -1), length);
  if (!lua_getmetatable(L, -1)) lua_pushnil(L);
  persist(pi);
  lua_pop(L, 1);
}

/* 0x1401c2e20 */
static void persistfunction(PersistInfo *pi) {
  lua_State *L = pi->L;
  Closure *cl = clvalue(getobject(L, -1));
  lua_checkstack(L, 2);
  if (cl->c.isC) {
    lua_pushliteral(L, "Attempt to persist a C function");
    lua_error(L);
  }
  Proto *p = cl->l.p;
  write_byte(pi, p->nups);
  setptvalue(L, L->top, p);
  L->top++;
  persist(pi);
  lua_pop(L, 1);
  for (int i = 0; i < p->nups; i++) {
    pushtagged(L, obj2gco(cl->l.upvals[i]), LUA_TUPVAL);
    persist(pi);
    lua_pop(L, 1);
  }
  /* The global table is not persisted; unpersist installs the loading state's globals. */
  lua_getfenv(L, -1);
  if (lua_rawequal(L, -1, LUA_GLOBALSINDEX)) {
    lua_pop(L, 1);
    lua_pushnil(L);
  }
  persist(pi);
  lua_pop(L, 1);
}

static void pushstringornil(lua_State *L, TString *s) {
  if (s) {
    setsvalue(L, L->top, s);
    L->top++;
  } else {
    lua_pushnil(L);
  }
}

/* 0x1401c3070 */
static void persistproto(PersistInfo *pi) {
  lua_State *L = pi->L;
  Proto *p = pvalue(getobject(L, -1));
  lua_checkstack(L, 2);
  write_int(pi, p->sizek);
  for (int i = 0; i < p->sizek; i++) {
    setobj2s(L, L->top, &p->k[i]);
    L->top++;
    persist(pi);
    lua_pop(L, 1);
  }
  write_int(pi, p->sizep);
  for (int i = 0; i < p->sizep; i++) {
    setptvalue(L, L->top, p->p[i]);
    L->top++;
    persist(pi);
    lua_pop(L, 1);
  }
  write_int(pi, p->sizecode);
  write_bytes(pi, p->code, sizeof(Instruction) * p->sizecode);
  write_int(pi, p->sizeupvalues);
  for (int i = 0; i < p->sizeupvalues; i++) {
    pushstringornil(L, p->upvalues[i]);
    persist(pi);
    lua_pop(L, 1);
  }
  write_int(pi, p->sizelocvars);
  for (int i = 0; i < p->sizelocvars; i++) {
    pushstringornil(L, p->locvars[i].varname);
    persist(pi);
    lua_pop(L, 1);
    write_int(pi, p->locvars[i].startpc);
    write_int(pi, p->locvars[i].endpc);
  }
  pushstringornil(L, p->source);
  persist(pi);
  lua_pop(L, 1);
  write_int(pi, p->sizelineinfo);
  if (p->sizelineinfo) write_bytes(pi, p->lineinfo, sizeof(int) * p->sizelineinfo);
  write_int(pi, p->linedefined);
  write_int(pi, p->lastlinedefined);
  write_byte(pi, p->nups);
  write_byte(pi, p->numparams);
  write_byte(pi, p->is_vararg);
  write_byte(pi, p->maxstacksize);
}

/* Instruction offset of a Lua frame; C frames have none. */
static int64_t savedpcoffset(lua_State *L2, CallInfo *ci) {
  if (ci == L2->base_ci || !ttisfunction(ci->func)) return 0;
  Closure *cl = clvalue(ci->func);
  if (cl->c.isC) return 0;
  return (int64_t)(ci->savedpc - cl->l.p->code);
}

/* 0x1401c33d0 */
static void persistthread(PersistInfo *pi) {
  lua_State *L = pi->L;
  lua_State *L2 = thvalue(getobject(L, -1));
  if (L2 == L) {
    lua_pushliteral(L, "Can't persist currently running thread");
    lua_error(L);
  }
  size_t stacksize = L2->top - L2->stack;
  luaL_checkstack(L, (int)stacksize + 1, "Pluto thread stack");
  /* Pushed in reverse so that the stack bottom is persisted first. */
  for (StkId o = L2->top - 1; o >= L2->stack; o--) {
    setobj2s(L, L->top, o);
    L->top++;
  }
  write_wide(pi, (int64_t)stacksize);
  for (size_t i = 0; i < stacksize; i++) {
    persist(pi);
    lua_pop(L, 1);
  }
  size_t frames = (L2->ci - L2->base_ci) + 1;
  write_wide(pi, (int64_t)frames);
  for (size_t i = 0; i < frames; i++) {
    CallInfo *ci = L2->base_ci + i;
    write_wide(pi, ci->base - L2->stack);
    write_wide(pi, ci->func - L2->stack);
    write_wide(pi, ci->top - L2->stack);
    write_int(pi, ci->nresults);
    write_wide(pi, savedpcoffset(L2, ci));
  }
  write_byte(pi, L2->status);
  write_wide(pi, L2->base - L2->stack);
  write_wide(pi, L2->top - L2->stack);
  write_wide(pi, (int64_t)L2->errfunc);
  /* Open upvalues, innermost stack slot first, each followed by its stack position. */
  for (GCObject *o = L2->openupval; o != NULL; o = o->gch.next) {
    UpVal *uv = gco2uv(o);
    pushtagged(L, o, LUA_TUPVAL);
    persist(pi);
    lua_pop(L, 1);
    write_wide(pi, uv->v - L2->stack);
  }
  lua_pushnil(L);
  persist(pi);
  lua_pop(L, 1);
}

/* 0x1401c3710 */
static void persist(PersistInfo *pi) {
  lua_State *L = pi->L;
  for (;;) {
    lua_checkstack(L, 2);
    lua_pushvalue(L, -1);
    lua_rawget(L, 2);
    if (!lua_isnil(L, -1)) {
      int ref = (int)(intptr_t)lua_touserdata(L, -1);
      write_int(pi, 0);
      write_int(pi, ref);
      lua_pop(L, 1);
      return;
    }
    lua_pop(L, 1);
    if (lua_isnil(L, -1)) {
      /* Not first time, reference 0. */
      write_int(pi, 0);
      write_int(pi, 0);
      return;
    }
    write_int(pi, 1);
    lua_pushvalue(L, -1);
    lua_pushlightuserdata(L, (void *)(intptr_t)(++pi->counter));
    lua_rawset(L, 2);
    write_int(pi, pi->counter);
    lua_pushvalue(L, -1);
    lua_gettable(L, 1);
    if (!lua_isnil(L, -1)) {
      write_int(pi, PLUTO_TPERMANENT);
      persist(pi);
      lua_pop(L, 1);
      return;
    }
    lua_pop(L, 1);
    int type = ttype(getobject(L, -1));
    write_int(pi, type);
    switch (type) {
    case LUA_TBOOLEAN:
      write_int(pi, lua_toboolean(L, -1));
      return;
    case LUA_TLIGHTUSERDATA:
      write_wide(pi, (int64_t)(intptr_t)lua_touserdata(L, -1));
      return;
    case LUA_TNUMBER: {
      lua_Number n = lua_tonumber(L, -1);
      write_bytes(pi, &n, sizeof n);
      return;
    }
    case LUA_TSTRING: {
      size_t length;
      const char *s = lua_tolstring(L, -1, &length);
      write_wide(pi, (int64_t)length);
      write_bytes(pi, s, length);
      return;
    }
    case LUA_TTABLE:
      persisttable(pi);
      return;
    case LUA_TFUNCTION:
      persistfunction(pi);
      return;
    case LUA_TUSERDATA:
      persistuserdata(pi);
      return;
    case LUA_TTHREAD:
      persistthread(pi);
      return;
    case LUA_TPROTO:
      persistproto(pi);
      return;
    case LUA_TUPVAL: {
      /* The upvalue object is registered; its current value follows. */
      UpVal *uv = gco2uv(gcvalue(getobject(L, -1)));
      setobj2s(L, getobject(L, -1), uv->v);
      continue;
    }
    default:
      return;
    }
  }
}

/* pluto.persist(perms, rootobj) -> string */
static int persist_l(lua_State *L) {
  lua_settop(L, 2);
  luaL_checktype(L, 1, LUA_TTABLE);
  /* perms rootobj -> perms reftbl buffer rootobj */
  lua_newtable(L);
  lua_newtable(L);
  lua_pushliteral(L, "__mode");
  lua_pushliteral(L, "k");
  lua_settable(L, 4);
  lua_setmetatable(L, 3);
  lua_insert(L, 2);
  Buffer *buffer = (Buffer *)lua_newuserdata(L, sizeof(Buffer));
  buffer->data = NULL;
  buffer->length = buffer->capacity = 0;
  luaL_getmetatable(L, "pluto.buffer");
  lua_setmetatable(L, -2);
  lua_insert(L, 3);
  PersistInfo pi = {L, 0, buffer};
  persist(&pi);
  lua_pushlstring(L, buffer->data ? buffer->data : "", buffer->length);
  return 1;
}

/* --- unpersist ------------------------------------------------------------------- */

typedef struct {
  lua_State *L;
  const char *data;
  size_t remaining;
} UnpersistInfo;

static void read_bytes(UnpersistInfo *upi, void *p, size_t n) {
  if (n > upi->remaining) luaL_error(upi->L, "Truncated Pluto data");
  memcpy(p, upi->data, n);
  upi->data += n;
  upi->remaining -= n;
}
static int read_int(UnpersistInfo *upi) {
  int value;
  read_bytes(upi, &value, 4);
  return value;
}
static lu_byte read_byte(UnpersistInfo *upi) {
  lu_byte value;
  read_bytes(upi, &value, 1);
  return value;
}
static int64_t read_wide(UnpersistInfo *upi) {
  int64_t value;
  read_bytes(upi, &value, 8);
  return value;
}
static size_t read_size(UnpersistInfo *upi) {
  int64_t value = read_wide(upi);
  if (value < 0 || (uint64_t)value > (uint64_t)(MAX_SIZET - 2))
    luaL_error(upi->L, "Pluto object too large");
  return (size_t)value;
}

static void unpersist(UnpersistInfo *upi);

/* 0x1401c4080: reftbl[ref] = object on top. */
static void registerobject(int ref, UnpersistInfo *upi) {
  lua_State *L = upi->L;
  lua_checkstack(L, 2);
  lua_pushlightuserdata(L, (void *)(intptr_t)ref);
  lua_pushvalue(L, -2);
  lua_settable(L, 2);
}

static Proto *makefakeproto(lua_State *L, lu_byte nups) {
  Proto *p = luaF_newproto(L);
  p->sizelineinfo = 1;
  p->lineinfo = luaM_newvector(L, 1, int);
  p->lineinfo[0] = 1;
  p->sizecode = 1;
  p->code = luaM_newvector(L, 1, Instruction);
  p->code[0] = CREATE_ABC(OP_RETURN, 0, 1, 0);
  p->source = luaS_newlstr(L, "", 0);
  p->maxstacksize = 2;
  p->nups = nups;
  p->sizek = 0;
  p->sizep = 0;
  return p;
}

/* A closed upvalue holding the value at the given stack slot. */
static UpVal *makeupval(lua_State *L, int index) {
  UpVal *uv = luaF_newupval(L);
  setobj(L, uv->v, getobject(L, index));
  return uv;
}

/* Upvalues travel boxed in a one-upvalue closure while unpersisting. */
static void boxupval_start(lua_State *L) {
  LClosure *lcl = &luaF_newLclosure(L, 1, hvalue(gt(L)))->l;
  setclvalue(L, L->top, (Closure *)lcl);
  L->top++;
  lcl->p = makefakeproto(L, 1);
  lua_pushnil(L);
  lcl->upvals[0] = makeupval(L, -1);
  lua_pop(L, 1);
}
static void boxupval_finish(lua_State *L) {
  LClosure *lcl = &clvalue(getobject(L, -2))->l;
  setobj(L, &lcl->upvals[0]->u.value, getobject(L, -1));
  lua_pop(L, 1);
}
static UpVal *unboxupval(lua_State *L) {
  if (!ttisfunction(getobject(L, -1)) || clvalue(getobject(L, -1))->c.isC)
    luaL_error(L, "Malformed Pluto upvalue");
  UpVal *uv = clvalue(getobject(L, -1))->l.upvals[0];
  lua_pop(L, 1);
  return uv;
}

/* 0x1401c4170 */
static void unpersisttable(int ref, UnpersistInfo *upi) {
  lua_State *L = upi->L;
  lua_checkstack(L, 3);
  if (read_int(upi)) {
    unpersist(upi);
    lua_call(L, 0, 1);
    return;
  }
  lua_newtable(L);
  registerobject(ref, upi);
  unpersist(upi);
  if (lua_istable(L, -1))
    lua_setmetatable(L, -2);
  else
    lua_pop(L, 1);
  for (;;) {
    unpersist(upi);
    if (lua_isnil(L, -1)) {
      lua_pop(L, 1);
      break;
    }
    unpersist(upi);
    lua_rawset(L, -3);
  }
}

/* 0x1401c5e50 */
static void unpersistuserdata(int ref, UnpersistInfo *upi) {
  lua_State *L = upi->L;
  lua_checkstack(L, 2);
  if (read_int(upi)) {
    unpersist(upi);
    lua_call(L, 0, 1);
    return;
  }
  size_t length = read_size(upi);
  lua_newuserdata(L, length);
  registerobject(ref, upi);
  read_bytes(upi, lua_touserdata(L, -1), length);
  unpersist(upi);
  lua_setmetatable(L, -2);
}

/* 0x1401c4550 */
static void unpersistfunction(int ref, UnpersistInfo *upi) {
  lua_State *L = upi->L;
  lua_checkstack(L, 2);
  lu_byte nups = read_byte(upi);
  LClosure *lcl = &luaF_newLclosure(L, nups, hvalue(gt(L)))->l;
  setclvalue(L, L->top, (Closure *)lcl);
  L->top++;
  /* Valid placeholders before the collector can see the closure. */
  lcl->p = makefakeproto(L, nups);
  lua_pushnil(L);
  for (int i = 0; i < nups; i++) lcl->upvals[i] = makeupval(L, -1);
  lua_pop(L, 1);
  registerobject(ref, upi);
  unpersist(upi);
  if (ttype(getobject(L, -1)) != LUA_TPROTO) luaL_error(L, "Malformed Pluto function");
  lcl->p = pvalue(getobject(L, -1));
  lua_pop(L, 1);
  for (int i = 0; i < nups; i++) {
    unpersist(upi);
    lcl->upvals[i] = unboxupval(L);
  }
  unpersist(upi);
  if (!lua_isnil(L, -1))
    lua_setfenv(L, -2);
  else
    lua_pop(L, 1);
}

static TString *popstring(lua_State *L) {
  const char *s = lua_tostring(L, -1);
  TString *ts = luaS_newlstr(L, s ? s : "", s ? strlen(s) : 0);
  lua_pop(L, 1);
  return ts;
}

/* 0x1401c4820 */
static void unpersistproto(int ref, UnpersistInfo *upi) {
  lua_State *L = upi->L;
  (void)ref;
  lua_checkstack(L, 2);
  TString *source = luaS_newlstr(L, "", 0);
  Proto *p = luaF_newproto(L);
  p->source = source;
  p->sizecode = 1;
  p->code = luaM_newvector(L, 1, Instruction);
  p->code[0] = CREATE_ABC(OP_RETURN, 0, 1, 0);
  p->maxstacksize = 2;
  p->sizek = 0;
  p->sizep = 0;
  setptvalue(L, L->top, p);
  L->top++;
  int sizek = read_int(upi);
  luaM_reallocvector(L, p->k, 0, sizek, TValue);
  for (int i = 0; i < sizek; i++) {
    unpersist(upi);
    setobj2s(L, &p->k[i], getobject(L, -1));
    p->sizek++;
    lua_pop(L, 1);
  }
  int sizep = read_int(upi);
  luaM_reallocvector(L, p->p, 0, sizep, Proto *);
  for (int i = 0; i < sizep; i++) {
    unpersist(upi);
    if (ttype(getobject(L, -1)) != LUA_TPROTO) luaL_error(L, "Malformed Pluto prototype");
    p->p[i] = pvalue(getobject(L, -1));
    p->sizep++;
    lua_pop(L, 1);
  }
  int sizecode = read_int(upi);
  luaM_reallocvector(L, p->code, 1, sizecode, Instruction);
  p->sizecode = sizecode;
  read_bytes(upi, p->code, sizeof(Instruction) * sizecode);
  int sizeupvalues = read_int(upi);
  if (sizeupvalues) {
    luaM_reallocvector(L, p->upvalues, 0, sizeupvalues, TString *);
    for (int i = 0; i < sizeupvalues; i++) p->upvalues[i] = NULL;
    p->sizeupvalues = sizeupvalues;
    for (int i = 0; i < sizeupvalues; i++) {
      unpersist(upi);
      p->upvalues[i] = popstring(L);
    }
  }
  int sizelocvars = read_int(upi);
  if (sizelocvars) {
    luaM_reallocvector(L, p->locvars, 0, sizelocvars, LocVar);
    for (int i = 0; i < sizelocvars; i++) p->locvars[i].varname = NULL;
    p->sizelocvars = sizelocvars;
    for (int i = 0; i < sizelocvars; i++) {
      unpersist(upi);
      p->locvars[i].varname = popstring(L);
      p->locvars[i].startpc = read_int(upi);
      p->locvars[i].endpc = read_int(upi);
    }
  }
  unpersist(upi);
  p->source = popstring(L);
  int sizelineinfo = read_int(upi);
  if (sizelineinfo) {
    luaM_reallocvector(L, p->lineinfo, 0, sizelineinfo, int);
    p->sizelineinfo = sizelineinfo;
    read_bytes(upi, p->lineinfo, sizeof(int) * sizelineinfo);
  }
  p->linedefined = read_int(upi);
  p->lastlinedefined = read_int(upi);
  p->nups = read_byte(upi);
  p->numparams = read_byte(upi);
  p->is_vararg = read_byte(upi);
  p->maxstacksize = read_byte(upi);
}

/* Removes a freshly linked object from the collector's root list. */
static void gcunlink(lua_State *L, GCObject *gco) {
  global_State *g = G(L);
  if (g->rootgc == gco) {
    g->rootgc = gco->gch.next;
    return;
  }
  GCObject *prev = g->rootgc;
  while (prev && prev->gch.next != gco) prev = prev->gch.next;
  if (prev) prev->gch.next = gco->gch.next;
}

static size_t read_stackoffset(UnpersistInfo *upi, lua_State *L2) {
  size_t offset = read_size(upi);
  if (offset > (size_t)L2->stacksize) luaL_error(upi->L, "Malformed Pluto thread");
  return offset;
}

/* 0x1401c5630 */
static void unpersistthread(int ref, UnpersistInfo *upi) {
  lua_State *L = upi->L;
  lua_State *L2 = lua_newthread(L);
  lua_checkstack(L, 3);
  registerobject(ref, upi);
  size_t stacksize = read_size(upi);
  if (stacksize > (size_t)INT_MAX / 2) luaL_error(L, "Malformed Pluto thread");
  luaD_growstack(L2, (int)stacksize);
  /* The first value is the imaginary top-level function at the stack bottom. */
  L2->top--;
  for (size_t i = 0; i < stacksize; i++) {
    unpersist(upi);
    lua_xmove(L, L2, 1);
  }
  size_t stacklimit = 0;
  size_t frames = read_size(upi);
  if (frames == 0 || frames > LUAI_MAXCALLS) luaL_error(L, "Malformed Pluto thread");
  luaD_reallocCI(L2, (int)frames * 2);
  for (size_t i = 0; i < frames; i++) {
    CallInfo *ci = L2->base_ci + i;
    size_t base = read_stackoffset(upi, L2), func = read_stackoffset(upi, L2),
           top = read_stackoffset(upi, L2);
    ci->nresults = read_int(upi);
    int64_t savedpc = read_wide(upi);
    if (stacklimit < top) stacklimit = top;
    ci->base = L2->stack + base;
    ci->func = L2->stack + func;
    ci->top = L2->stack + top;
    ci->savedpc = NULL;
    if (ci != L2->base_ci && ttisfunction(ci->func) && !clvalue(ci->func)->c.isC)
      ci->savedpc = clvalue(ci->func)->l.p->code + savedpc;
    ci->tailcalls = 0;
    L2->ci = ci;
  }
  L2->status = read_byte(upi);
  size_t base = read_stackoffset(upi, L2), top = read_stackoffset(upi, L2);
  L2->errfunc = (ptrdiff_t)read_wide(upi);
  L2->base = L2->stack + base;
  L2->top = L2->stack + top;
  for (StkId o = L2->top; o < L2->stack + L2->stacksize; o++) setnilvalue(o);
  (void)stacklimit;
  /* Reopen the persisted open upvalues on the new stack. */
  global_State *g = G(L2);
  GCObject **next = &L2->openupval;
  for (;;) {
    unpersist(upi);
    if (lua_isnil(L, -1)) {
      lua_pop(L, 1);
      break;
    }
    UpVal *uv = unboxupval(L);
    uv->v = L2->stack + read_stackoffset(upi, L2);
    gcunlink(L, obj2gco(uv));
    uv->marked = luaC_white(g);
    *next = obj2gco(uv);
    next = &uv->next;
    uv->u.l.prev = &g->uvhead;
    uv->u.l.next = g->uvhead.u.l.next;
    uv->u.l.next->u.l.prev = uv;
    g->uvhead.u.l.next = uv;
  }
  *next = NULL;
}

/* 0x1401c6050 */
static void unpersist(UnpersistInfo *upi) {
  lua_State *L = upi->L;
  lua_checkstack(L, 2);
  if (!read_int(upi)) {
    int ref = read_int(upi);
    if (ref == 0) {
      lua_pushnil(L);
    } else {
      lua_pushlightuserdata(L, (void *)(intptr_t)ref);
      lua_gettable(L, 2);
    }
    return;
  }
  int ref = read_int(upi);
  int type = read_int(upi);
  switch (type) {
  case LUA_TBOOLEAN:
    lua_pushboolean(L, read_int(upi) != 0);
    break;
  case LUA_TLIGHTUSERDATA:
    lua_pushlightuserdata(L, (void *)(intptr_t)read_wide(upi));
    break;
  case LUA_TNUMBER: {
    lua_Number n;
    read_bytes(upi, &n, sizeof n);
    lua_pushnumber(L, n);
    break;
  }
  case LUA_TSTRING: {
    size_t length = read_size(upi);
    if (length > upi->remaining) luaL_error(L, "Truncated Pluto data");
    lua_pushlstring(L, upi->data, length);
    upi->data += length;
    upi->remaining -= length;
    break;
  }
  case LUA_TTABLE:
    unpersisttable(ref, upi);
    break;
  case LUA_TFUNCTION:
    unpersistfunction(ref, upi);
    break;
  case LUA_TUSERDATA:
    unpersistuserdata(ref, upi);
    break;
  case LUA_TTHREAD:
    unpersistthread(ref, upi);
    break;
  case LUA_TPROTO:
    unpersistproto(ref, upi);
    break;
  case LUA_TUPVAL:
    boxupval_start(L);
    registerobject(ref, upi);
    unpersist(upi);
    boxupval_finish(L);
    break;
  case PLUTO_TPERMANENT:
    unpersist(upi);
    lua_gettable(L, 1);
    break;
  default:
    luaL_error(L, "Unknown Pluto type %d", type);
  }
  registerobject(ref, upi);
}

/* perms reftbl string -> object, with the reader as upvalue 1. */
static int unpersist_protected(lua_State *L) {
  unpersist((UnpersistInfo *)lua_touserdata(L, lua_upvalueindex(1)));
  return 1;
}

/* pluto.unpersist(perms, string) -> object */
static int unpersist_l(lua_State *L) {
  lua_settop(L, 2);
  size_t length;
  const char *data = luaL_checklstring(L, 2, &length);
  luaL_checktype(L, 1, LUA_TTABLE);
  /* perms string -> perms reftbl string; the string stays anchored while reading. */
  lua_newtable(L);
  lua_insert(L, 2);
  UnpersistInfo upi = {L, data, length};
  /* The collector is held off while objects are only partly built. Unlike the native
   * build, a malformed stream re-enables it before the error propagates. */
  global_State *g = G(L);
  g->GCthreshold = MAX_LUMEM;
  lua_pushlightuserdata(L, &upi);
  lua_pushcclosure(L, unpersist_protected, 1);
  lua_insert(L, 1);
  int status = lua_pcall(L, 3, 1, 0);
  g->GCthreshold = g->totalbytes;
  if (status) lua_error(L);
  return 1;
}

static const luaL_Reg pluto_reg[] = {
  {"persist", persist_l},
  {"unpersist", unpersist_l},
  {NULL, NULL},
};

int luaopen_pluto(lua_State *L) {
  luaL_newmetatable(L, "pluto.buffer");
  lua_pushcfunction(L, buffer_gc);
  lua_setfield(L, -2, "__gc");
  lua_pop(L, 1);
  luaL_register(L, "pluto", pluto_reg);
  return 1;
}
