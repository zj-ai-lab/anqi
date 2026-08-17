import java.io.File

plugins {
    alias(libs.plugins.android.application)
    // AGP 9.0+ 内置 Kotlin 支持，不再 apply org.jetbrains.kotlin.android。
}

/**
 * 签名材料的取处，本机与 CI 共用一套逻辑：
 *  - 本机：默认读 ~/.keys/anjian-android.jks + ~/.keys/anjian-android.pass（600）；
 *  - CI  ：workflow 把 secret 还原成文件后，用 ANDROID_KEYSTORE_PATH / ANDROID_KEYSTORE_PASSWORD 覆盖。
 * 两者都拿不到时不装 signingConfig，assembleRelease 会出未签名包（本地也能编，便于纯编译验证）。
 */
val keystoreFile: File? = (System.getenv("ANDROID_KEYSTORE_PATH")
    ?: "${System.getProperty("user.home")}/.keys/anjian-android.jks")
    .let(::File).takeIf { it.isFile }

val keystorePassword: String? = System.getenv("ANDROID_KEYSTORE_PASSWORD")
    ?: File("${System.getProperty("user.home")}/.keys/anjian-android.pass")
        .takeIf { it.isFile }?.readText()?.trim()

val keyAliasName: String = System.getenv("ANDROID_KEY_ALIAS") ?: "anjian"

android {
    namespace = "com.fdong.anjian"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.fdong.anjian"
        minSdk = 26          // 自适应图标起点，覆盖面足够
        targetSdk = 36
        versionCode = 2
        versionName = "1.1.0"
    }

    signingConfigs {
        if (keystoreFile != null && keystorePassword != null) {
            create("release") {
                storeFile = keystoreFile
                storePassword = keystorePassword
                keyAlias = keyAliasName
                keyPassword = keystorePassword   // keytool 生成时 keypass 与 storepass 同值
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    sourceSets {
        getByName("main") {
            kotlin.srcDir("src/main/kotlin")
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
}
