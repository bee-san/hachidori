cmake_minimum_required(VERSION 3.31)

project(hachidori LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# -fwasm-exceptions is an ABI choice: every translation unit that appears in the
# final link must agree, including the engine's and its vendored C deps. Putting
# it in CMAKE_{C,CXX}_FLAGS rather than on our target is what makes that true for
# the add_subdirectory'd trees.
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fwasm-exceptions -O3")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fwasm-exceptions -O3")

add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../third_party/hoshidicts hoshidicts)

add_executable(hoshidicts_wasm bindings.cpp)

set_target_properties(hoshidicts_wasm PROPERTIES OUTPUT_NAME hoshidicts SUFFIX ".mjs")

# The engine links glaze PRIVATE, so its include dirs do not propagate here.
target_link_libraries(hoshidicts_wasm PRIVATE hoshidicts glaze::glaze)

# src/ is not in the engine's public include set. hdw_import reaches into it for
# zip/zip.hpp so it can read the archive's declared title before handing the
# archive to an importer that turns that title into a directory it may delete.
target_include_directories(hoshidicts_wasm PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/hoshidicts/src)

target_link_options(hoshidicts_wasm PRIVATE
    -O3
    -fwasm-exceptions
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createHoshidicts
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sMAXIMUM_MEMORY=4GB
    -sSTACK_SIZE=8MB
    -sFORCE_FILESYSTEM=1
    -lidbfs.js
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,IDBFS,UTF8ToString,stringToNewUTF8,HEAPU8,lengthBytesUTF8
    -sEXPORTED_FUNCTIONS=_malloc,_free,_hdw_import,_hdw_reset,_hdw_add_dict,_hdw_lookup,_hdw_kanji,_hdw_styles,_hdw_media,_hdw_media_data,_hdw_last_error
)
