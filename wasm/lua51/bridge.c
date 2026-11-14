/* Host embedding for unmodified Lua 5.1.5. See vendor/COPYRIGHT. */
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
#include "lundump.h"
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

int luaopen_pluto(lua_State *L);

__attribute__((import_module("host"), import_name("call")))
extern int host_call(lua_State *L, const char *method, size_t length);

__attribute__((import_module("host"), import_name("interrupt")))
extern void host_interrupt(void);
static int remaining;
static void budget_hook(lua_State *L, lua_Debug *ar) {
  (void)ar;
  remaining -= 1000;
  if (remaining <= 0) host_interrupt();
}
static void budget(lua_State *L, int limit) {
  if (limit > 0) {
    remaining = limit;
    lua_sethook(L, budget_hook, LUA_MASKCOUNT, 1000);
  }
}
static int dispatch(lua_State *L) {
  size_t length;
  const char *method = lua_tolstring(L, lua_upvalueindex(1), &length);
  int n = host_call(L, method, length);
  if (n < 0) return lua_error(L);
  return n;
}
static int missing(lua_State *L) {
  return luaL_error(L, "Unsupported engine method '%s'", lua_tostring(L, 2));
}
static int disabled(lua_State *L) {
  return luaL_error(L, "Host filesystem loading is unavailable; use engine:include");
}
static int initialize(lua_State *L) {
  lua_pushcfunction(L, luaopen_base); lua_pushliteral(L, ""); lua_call(L, 1, 0);
  lua_pushcfunction(L, luaopen_table); lua_pushliteral(L, LUA_TABLIBNAME); lua_call(L, 1, 0);
  lua_pushcfunction(L, luaopen_string); lua_pushliteral(L, LUA_STRLIBNAME); lua_call(L, 1, 0);
  lua_pushcfunction(L, luaopen_math); lua_pushliteral(L, LUA_MATHLIBNAME); lua_call(L, 1, 0);
  lua_pushcfunction(L, luaopen_pluto); lua_pushliteral(L, "pluto"); lua_call(L, 1, 0);
  /* Loading host paths is deliberately delegated to the platform file resolver. */
  lua_pushcfunction(L, disabled); lua_setglobal(L, "dofile");
  lua_pushcfunction(L, disabled); lua_setglobal(L, "loadfile");
  lua_pushnil(L); lua_setglobal(L, "print");
  lua_newtable(L);
  lua_newtable(L); lua_pushcfunction(L, missing); lua_setfield(L, -2, "__index");
  lua_setmetatable(L, -2); lua_setglobal(L, "engine");
  return 0;
}
/* One Lua state per module instance; malloc is bounded by the wasm memory maximum. */
lua_State *lua51_new(void) {
  lua_State *L = luaL_newstate();
  if (!L) return NULL;
  lua_pushcfunction(L, initialize);
  if (lua_pcall(L, 0, 0, 0)) { lua_close(L); return NULL; }
  return L;
}
void lua51_close(lua_State *L) { lua_close(L); }
void lua51_bind(lua_State *L, const char *name, size_t length) {
  lua_getglobal(L, "engine"); lua_pushlstring(L, name, length);
  lua_pushvalue(L, -1); lua_pushcclosure(L, dispatch, 1); lua_rawset(L, -3); lua_pop(L, 1);
}
/* Only the exact module ABI is accepted: Lua 5.1, little-endian, 32-bit int,
 * size_t and Instruction, 64-bit floating lua_Number. Upstream undump retains
 * its complete header/prototype/instruction checks; binaries are not trusted. */
static int load_chunk(lua_State *L, const char *bytes, size_t length, const char *name) {
  if (length && (unsigned char)bytes[0] == 0x1b) {
    char header[LUAC_HEADERSIZE];
    luaU_header(header);
    if (length < sizeof(header) || memcmp(bytes, header, sizeof(header))) {
      lua_pushliteral(L, "Unsupported Lua bytecode ABI"); return LUA_ERRSYNTAX;
    }
  }
  return luaL_loadbuffer(L, bytes, length, name);
}
int lua51_eval(lua_State *L, const char *bytes, size_t length, const char *name, int limit) {
  budget(L, limit);
  int result = load_chunk(L, bytes, length, name);
  if (result) return result;
  return lua_pcall(L, 0, 0, 0);
}
int lua51_compile(lua_State *L, const char *bytes, size_t length, const char *name) {
  int result = load_chunk(L, bytes, length, name);
  if (!result) lua_pop(L, 1);
  return result;
}
int lua51_call(lua_State *L, const char *name, int limit) {
  budget(L, limit);
  lua_getglobal(L, name);
  if (!lua_isfunction(L, -1)) { lua_pop(L, 1); lua_pushliteral(L, "Missing Lua function"); return LUA_ERRRUN; }
  lua_getglobal(L, "engine");
  return lua_pcall(L, 1, 0, 0);
}
int lua51_top(lua_State *L) { return lua_gettop(L); }
void lua51_settop(lua_State *L, int n) { lua_settop(L, n); }
int lua51_type(lua_State *L, int i) { return lua_type(L, i); }
double lua51_number(lua_State *L, int i) { return lua_tonumber(L, i); }
int lua51_boolean(lua_State *L, int i) { return lua_toboolean(L, i); }
const char *lua51_string(lua_State *L, int i) { return lua_tolstring(L, i, NULL); }
size_t lua51_length(lua_State *L, int i) { size_t n; lua_tolstring(L, i, &n); return n; }
const void *lua51_pointer(lua_State *L, int i) { return lua_topointer(L, i); }
void lua51_nil(lua_State *L) { lua_pushnil(L); }
void lua51_pushnumber(lua_State *L, double n) { lua_pushnumber(L, n); }
void lua51_pushboolean(lua_State *L, int n) { lua_pushboolean(L, n); }
void lua51_pushstring(lua_State *L, const char *p, size_t n) { lua_pushlstring(L, p, n); }
void lua51_table(lua_State *L) { lua_newtable(L); }
void lua51_rawset(lua_State *L, int i) { lua_rawset(L, i); }
int lua51_next(lua_State *L, int i) { return lua_next(L, i); }
void lua51_global(lua_State *L, const char *name) { lua_getglobal(L, name); }
void lua51_setglobal(lua_State *L, const char *name) { lua_setglobal(L, name); }
int lua51_ref(lua_State *L, int index) { lua_pushvalue(L, index); return luaL_ref(L, LUA_REGISTRYINDEX); }
void lua51_unref(lua_State *L, int ref) { luaL_unref(L, LUA_REGISTRYINDEX, ref); }
void lua51_pushref(lua_State *L, int ref) { lua_rawgeti(L, LUA_REGISTRYINDEX, ref); }
void lua51_fieldref(lua_State *L, int ref, const char *key) { lua_rawgeti(L, LUA_REGISTRYINDEX, ref); lua_pushstring(L, key); lua_rawget(L, -2); lua_remove(L, -2); }
int lua51_invokeref(lua_State *L, int ref, int nargs, int with_engine, int limit) {
  budget(L, limit);
  lua_rawgeti(L, LUA_REGISTRYINDEX, ref); lua_insert(L, -nargs-1);
  if (with_engine) { lua_getglobal(L, "engine"); lua_insert(L, -nargs-1); nargs++; }
  return lua_pcall(L, nargs, LUA_MULTRET, 0);
}
int lua51_newthreadref(lua_State *L, int function_ref, int with_engine) {
  lua_State *thread = lua_newthread(L);
  lua_rawgeti(L, LUA_REGISTRYINDEX, function_ref);
  lua_xmove(L, thread, 1);
  if (with_engine) { lua_getglobal(L, "engine"); lua_xmove(L, thread, 1); }
  return luaL_ref(L, LUA_REGISTRYINDEX);
}
int lua51_resumethread(lua_State *L, int ref, int nargs, int initial_engine, int limit) {
  lua_rawgeti(L, LUA_REGISTRYINDEX, ref);
  lua_State *thread = lua_tothread(L, -1);
  lua_pop(L, 1);
  if (!thread) { lua_pushliteral(L, "Missing Lua thread"); return LUA_ERRRUN; }
  budget(thread, limit);
  lua_xmove(L, thread, nargs);
  int status = lua_resume(thread, nargs + initial_engine);
  lua_xmove(thread, L, lua_gettop(thread));
  return status;
}
