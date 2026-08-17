pluginManagement {
    repositories {
        // Aliyun domestic mirrors first — fast and stable from Shenzhen, and they
        // avoid the OpenClash transparent proxy which randomly resets TLS to
        // repo.maven.apache.org and blocks the GitHub distribution redirect.
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        // Upstream fallbacks (only hit if a mirror lacks an artifact).
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        google()
        mavenCentral()
    }
}

rootProject.name = "anjian-android"
include(":app")
