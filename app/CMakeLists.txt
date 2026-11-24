cmake_minimum_required(VERSION 3.22.1)

project(rolephone CXX)

add_library(native-lib SHARED src/main/cpp/native-lib.cpp)

# libnode 的头文件（CI 从 nodejs-mobile 的 zip 里解出来）
include_directories(libnode/include/node/)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
    IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)

target_link_libraries(native-lib libnode ${log-lib})
