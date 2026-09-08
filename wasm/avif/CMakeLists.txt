cmake_minimum_required(VERSION 3.31)

project(hachidori_avif LANGUAGES C)

include(FetchContent)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(AVIF_CODEC_AOM LOCAL CACHE STRING "" FORCE)
set(AVIF_CODEC_AOM_DECODE OFF CACHE BOOL "" FORCE)
set(AVIF_CODEC_AOM_ENCODE ON CACHE BOOL "" FORCE)
set(AVIF_LIBYUV OFF CACHE BOOL "" FORCE)
set(AVIF_LIBSHARPYUV OFF CACHE BOOL "" FORCE)
set(AVIF_JPEG OFF CACHE BOOL "" FORCE)
set(AVIF_ZLIBPNG OFF CACHE BOOL "" FORCE)
set(AVIF_BUILD_APPS OFF CACHE BOOL "" FORCE)
set(AVIF_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(AOM_TARGET_CPU generic CACHE STRING "" FORCE)
set(CONFIG_RUNTIME_CPU_DETECT 0 CACHE STRING "" FORCE)

FetchContent_Declare(
  libavif
  GIT_REPOSITORY https://github.com/AOMediaCodec/libavif.git
  GIT_TAG 1aadfad932c98c069a1204261b1856f81f3bc199
  GIT_SHALLOW FALSE
)
FetchContent_MakeAvailable(libavif)

add_executable(hachidori_avif encoder.c)
set_target_properties(hachidori_avif PROPERTIES OUTPUT_NAME avif-encoder SUFFIX ".mjs")
target_compile_features(hachidori_avif PRIVATE c_std_11)
target_compile_options(hachidori_avif PRIVATE -Oz)
target_link_libraries(hachidori_avif PRIVATE avif)
target_link_options(hachidori_avif PRIVATE
  -Oz
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createAvifEncoderModule
  -sENVIRONMENT=worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=32MB
  -sMAXIMUM_MEMORY=256MB
  -sSTACK_SIZE=1MB
  -sFILESYSTEM=0
  -sMALLOC=emmalloc
  -sEXPORTED_FUNCTIONS=_malloc,_free,_hda_create,_hda_add_rgba,_hda_finish,_hda_output,_hda_output_size,_hda_last_error,_hda_destroy
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString
)
