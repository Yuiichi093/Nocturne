#include <jni.h>
#include <cstdlib>
#include <cstring>
#include "node.h"

// libuv 要求 argv 是一段连续内存，所以先把 Java 传来的参数拷进一个 buffer
extern "C" jint JNICALL
Java_com_huaxueyi_rolephone_MainActivity_startNodeWithArguments(
        JNIEnv *env, jobject /* this */, jobjectArray arguments) {

    jsize argument_count = env->GetArrayLength(arguments);

    int c_arguments_size = 0;
    for (int i = 0; i < argument_count; i++) {
        c_arguments_size += strlen(env->GetStringUTFChars(
                (jstring) env->GetObjectArrayElement(arguments, i), 0));
        c_arguments_size++;
    }

    char *args_buffer = (char *) calloc(c_arguments_size, sizeof(char));
    char *argv[argument_count];
    char *current_args_position = args_buffer;

    for (int i = 0; i < argument_count; i++) {
        const char *current_argument = env->GetStringUTFChars(
                (jstring) env->GetObjectArrayElement(arguments, i), 0);
        strncpy(current_args_position, current_argument, strlen(current_argument));
        argv[i] = current_args_position;
        current_args_position += strlen(current_args_position) + 1;
    }

    return jint(node::Start(argument_count, argv));
}
