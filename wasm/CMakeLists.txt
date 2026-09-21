cmake_minimum_required(VERSION 3.31)

project(hachidori LANGUAGES C CXX)

option(HACHIDORI_PTHREADS "Build a pthread runtime" ON)
# With pthreads, WasmFS + direct OPFS is the primary runtime. Turning this off
# keeps the threads but stores through the classic FS + IDBFS, for hosts such as
# Electron that expose shared memory and workers but refuse OPFS access handles
# to chrome-extension:// origins.
option(HACHIDORI_WASMFS "Use WasmFS + direct OPFS with pthreads" ON)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# -fwasm-exceptions is an ABI choice: every translation unit that appears in the
# final link must agree, including the engine's and its vendored C deps. Putting
# it in CMAKE_{C,CXX}_FLAGS rather than on our target is what makes that true for
# the add_subdirectory'd trees.
# Every supported host (Chrome >= 128, Electron, Node) has wasm SIMD, and
# link-time optimisation lets the engine, zstd, glaze, and libdeflate inline
# across each other (measured: native lookups 15-30% faster, imports 4-8%;
# output files identical). xxHash would route wasm SIMD through the SIMDe
# arm_neon.h shim, which drags C++ headers inside its extern "C" block; keep
# xxHash scalar and let the compiler vectorise everything else.
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fwasm-exceptions -O3 -msimd128 -flto")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fwasm-exceptions -O3 -msimd128 -flto")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -D'XXH_HAS_INCLUDE(x)=0'")
if(HACHIDORI_PTHREADS)
  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -pthread")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -pthread")
endif()

# The WasmFS runtime reads dictionary files through sync access handles (see
# hoshidicts src/memory/memory.cpp); the classic-FS runtimes must not.
if(HACHIDORI_PTHREADS AND HACHIDORI_WASMFS)
  set(HOSHIDICTS_WASMFS ON CACHE BOOL "" FORCE)
else()
  set(HOSHIDICTS_WASMFS OFF CACHE BOOL "" FORCE)
endif()
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../third_party/hoshidicts hoshidicts)

add_executable(hoshidicts_wasm bindings.cpp)

if(HACHIDORI_PTHREADS AND NOT HACHIDORI_WASMFS)
  set_target_properties(hoshidicts_wasm PROPERTIES OUTPUT_NAME hoshidicts-threaded-idbfs SUFFIX ".mjs")
elseif(HACHIDORI_PTHREADS)
  set_target_properties(hoshidicts_wasm PROPERTIES OUTPUT_NAME hoshidicts-threaded SUFFIX ".mjs")
else()
  set_target_properties(hoshidicts_wasm PROPERTIES OUTPUT_NAME hoshidicts SUFFIX ".mjs")
endif()

# The engine links glaze PRIVATE, so its include dirs do not propagate here.
target_link_libraries(hoshidicts_wasm PRIVATE hoshidicts glaze::glaze)

# src/ is not in the engine's public include set. hdw_import reaches into it for
# zip/zip.hpp so it can read the archive's declared title before handing the
# archive to an importer that turns that title into a directory it may delete.
target_include_directories(hoshidicts_wasm PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/hoshidicts/src)

if(HACHIDORI_PTHREADS AND HACHIDORI_WASMFS)
  target_compile_definitions(hoshidicts_wasm PRIVATE HACHIDORI_OPFS=1)
endif()

target_link_options(hoshidicts_wasm PRIVATE
    -O3
    -fwasm-exceptions
    -flto
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createHoshidicts
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sMAXIMUM_MEMORY=4GB
    -sSTACK_SIZE=8MB
    -sFORCE_FILESYSTEM=1
    -sEXPORTED_FUNCTIONS=_malloc,_free,_hdw_init_storage,_hdw_import,_hdw_reset,_hdw_add_dict,_hdw_remove_dict,_hdw_set_dict_order,_hdw_lookup,_hdw_lookup_dictionary,_hdw_kanji,_hdw_styles,_hdw_media,_hdw_media_data,_hdw_last_error
)

# The pool is sized when the module starts: the bounded import worker group
# plus one thread for the WasmFS OPFS proxy. A host that wants the low-memory
# worker sets globalThis.HACHIDORI_PTHREAD_POOL_SIZE before createHoshidicts
# (engine-worker-runtime.js: one importer thread plus the proxy).
if(HACHIDORI_PTHREADS)
  target_link_options(hoshidicts_wasm PRIVATE
      -pthread
      "SHELL:-sPTHREAD_POOL_SIZE=globalThis.HACHIDORI_PTHREAD_POOL_SIZE??(Math.max(2,Math.min(globalThis.navigator?.hardwareConcurrency||1,8))+1)"
      -sPTHREAD_POOL_SIZE_STRICT=2
      -sPTHREAD_POOL_DELAY_LOAD=0
      -sALLOW_BLOCKING_ON_MAIN_THREAD=0
  )
endif()

if(HACHIDORI_PTHREADS AND HACHIDORI_WASMFS)
  target_link_options(hoshidicts_wasm PRIVATE
      -sWASMFS=1
      -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,UTF8ToString,stringToNewUTF8,HEAPU8,lengthBytesUTF8
  )
else()
  target_link_options(hoshidicts_wasm PRIVATE
      -lidbfs.js
      -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,IDBFS,UTF8ToString,stringToNewUTF8,HEAPU8,lengthBytesUTF8
  )
endif()
