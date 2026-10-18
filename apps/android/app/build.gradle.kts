plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.roborazzi)
}

android {
    namespace = "dev.hercule.android"
    // Compose 1.12 refuses to build against less than 37. targetSdk stays at 36, because
    // targeting 37 turns on Android 17's local-network rules, untested over Tailscale.
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.hercule.android"
        minSdk = 36
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    buildFeatures {
        compose = true
    }

    testOptions {
        // Robolectric and Roborazzi read the app's real resources, the bundled fonts among them.
        unitTests.isIncludeAndroidResources = true
        // Robolectric reaches into JDK internals, which Java 17 and later close by default.
        // This is the list from https://robolectric.org/getting-started/ for Robolectric 4.17.
        unitTests.all {
            it.jvmArgs(
                "--add-opens=java.base/java.lang=ALL-UNNAMED",
                "--add-opens=java.base/java.util=ALL-UNNAMED",
                "--add-opens=java.base/java.io=ALL-UNNAMED",
                "--add-opens=java.base/java.net=ALL-UNNAMED",
                "--add-opens=java.base/java.security=ALL-UNNAMED",
                "--add-opens=java.base/java.text=ALL-UNNAMED",
                "--add-opens=java.base/jdk.internal.access=ALL-UNNAMED",
                "--add-opens=java.desktop/java.awt.font=ALL-UNNAMED",
                "--add-opens=jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED",
            )
        }
    }

    lint {
        warningsAsErrors = true
        abortOnError = true
        disable += setOf(
            // targetSdk stays at 36 on purpose; see compileSdk above.
            "OldTargetApi",
            // Versions are pinned exactly and upgraded deliberately, never because one is newer.
            "AndroidGradlePluginVersion",
            "GradleDependency",
            "NewerVersionAvailable",
        )
    }
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        allWarningsAsErrors = true
    }
}

roborazzi {
    // The goldens are committed; verifyRoborazziDebug compares against them.
    outputDir.set(file("src/test/screenshots"))
}

// OkHttp 5 publishes an Android build and a JVM build of one module, and Gradle gives the unit
// tests the Android build. On the plain JVM its logging setup calls android.util.Log, which
// the JVM test stubs do not implement, so every test run printed a stack trace. The unit tests
// get the JVM build instead. This changes the tests' classpath only, unlike
// unitTests.isReturnDefaultValues, which would hide every other unmocked Android call too.
configurations.matching { it.name.endsWith("UnitTestRuntimeClasspath") }.configureEach {
    resolutionStrategy.dependencySubstitution {
        substitute(module("com.squareup.okhttp3:okhttp"))
            .using(module("com.squareup.okhttp3:okhttp-jvm:${libs.versions.okhttp.get()}"))
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.core)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.viewmodel.navigation3)
    implementation(libs.androidx.navigation3.runtime)
    implementation(libs.androidx.navigation3.ui)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.commonmark)
    implementation(libs.commonmark.ext.gfm.tables)
    implementation(libs.commonmark.ext.gfm.strikethrough)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.robolectric)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.roborazzi.junit.rule)
}
